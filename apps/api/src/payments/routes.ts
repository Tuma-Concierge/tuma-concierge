import { Hono, type Context } from "hono";
import { db } from "../db/client.js";
import { requireAuth } from "../auth/middleware.js";
import { newId } from "../lib/ids.js";
import { verifyWebhookSignature } from "./flutterwave/wire.js";
import { checkPaymentStatus } from "./service.js";

export const paymentRoutes = new Hono();

type Row = Record<string, unknown>;

async function logEvent(orderId: string, stage: string, note: string, actorId: string) {
  await db.execute({
    sql: "INSERT INTO order_events (id, order_id, stage, note, actor_id) VALUES (?, ?, ?, ?, ?)",
    args: [newId("evt"), orderId, stage, note, actorId],
  });
}

/**
 * Ask the provider what really happened to a pending payment and record it.
 * Shared by the client poll and the Yo! webhook so both arrive at the same
 * state by the same route — the provider's own answer, never a status
 * handed to us by whoever made the request.
 *
 * Returns whether anything changed. Caller must have already established
 * that the payment is still pending.
 */
async function applyPaymentStatus(payment: Row, actorId: string): Promise<boolean> {
  const status = await checkPaymentStatus({
    provider: payment.provider as string,
    provider_ref: payment.provider_ref as string | null,
    created_at: payment.created_at as string,
  });
  if (status === "pending") return false;

  if (status === "failed") {
    await db.execute({
      sql: "UPDATE payments SET status = 'failed', updated_at = datetime('now') WHERE id = ?",
      args: [payment.id as string],
    });
    return true;
  }

  // Only flip to successful from pending, so two callers racing (a poll and
  // a webhook landing together) can't advance the order's stage twice.
  const settled = await db.execute({
    sql: "UPDATE payments SET status = 'successful', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    args: [payment.id as string],
  });
  if (settled.rowsAffected === 0) return false;

  if (payment.type === "collection") {
    const advanced = await db.execute({
      sql: "UPDATE orders SET stage = 'Shop', updated_at = datetime('now') WHERE id = ? AND stage = 'Fund'",
      args: [payment.order_id as string],
    });
    if (advanced.rowsAffected > 0) {
      await logEvent(payment.order_id as string, "Shop", "Escrow funded — shopping started", actorId);
    }
  }
  return true;
}

/**
 * Poll a payment's status against the mobile money provider (mock or live
 * Yo! Payments). Sandbox/mock testing has no public webhook target, so the
 * client polls this instead of relying solely on /payments/yo/callback.
 */
paymentRoutes.get("/payments/:id/refresh", requireAuth, async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const res = await db.execute({ sql: "SELECT * FROM payments WHERE id = ?", args: [id] });
  const payment = res.rows[0] as Row | undefined;
  if (!payment) return c.json({ error: "not_found" }, 404);

  const orderRes = await db.execute({ sql: "SELECT * FROM orders WHERE id = ?", args: [payment.order_id as string] });
  const order = orderRes.rows[0] as Row | undefined;
  if (!order) return c.json({ error: "order_not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  if (payment.status !== "pending") {
    return c.json({ payment });
  }

  try {
    await applyPaymentStatus(payment, user.sub);
    const updated = await db.execute({ sql: "SELECT * FROM payments WHERE id = ?", args: [id] });
    return c.json({ payment: updated.rows[0] });
  } catch (err) {
    console.error("Payment status check failed:", err);
    return c.json(
      { error: "payment_status_check_failed", message: "Couldn't check the payment status just now. Please try again." },
      502,
    );
  }
});

/**
 * Real Yo! Payments webhook target (requires YO_CALLBACK_URL to be a public
 * HTTPS endpoint).
 *
 * Two rules here, and both matter:
 *
 * 1. **The caller has to prove it's Yo!.** The callback URL you register
 *    with them carries a secret (`?token=…`, or an `X-Tuma-Callback-Token`
 *    header), and anything without it is refused. Without this the endpoint
 *    is an open door for anyone who wants to move payments around or just
 *    flood the logs.
 *
 * 2. **The body is a hint, never the truth.** Even a correctly
 *    authenticated payload only tells us *which* transaction changed — the
 *    new status is then read back from Yo!'s own API. So a forged or
 *    replayed callback can at worst make us re-check a payment we already
 *    know about, which is harmless.
 */
function callbackAuthorized(c: Context): boolean {
  const expected = process.env.YO_CALLBACK_SECRET;
  // Refuse rather than wave everything through when unconfigured — an
  // endpoint that moves money shouldn't be open because a var is missing.
  if (!expected) return false;
  const provided = c.req.header("x-tuma-callback-token") ?? c.req.query("token") ?? "";
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

paymentRoutes.post("/payments/yo/callback", async (c) => {
  if (!callbackAuthorized(c)) {
    console.warn("Rejected unauthenticated Yo! callback from", c.req.header("cf-connecting-ip") ?? "unknown");
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reference = String(
    body.TransactionReference ?? body.transaction_reference ?? body.ExternalReference ?? body.external_reference ?? "",
  ).trim();
  if (!reference) return c.json({ received: true, matched: false });

  const res = await db.execute({
    sql: "SELECT * FROM payments WHERE provider_ref = ? OR id = ? LIMIT 1",
    args: [reference, reference],
  });
  const payment = res.rows[0] as Row | undefined;
  if (!payment) return c.json({ received: true, matched: false });
  if (payment.status !== "pending") return c.json({ received: true, matched: true, changed: false });

  try {
    const changed = await applyPaymentStatus(payment, "yo-callback");
    return c.json({ received: true, matched: true, changed });
  } catch (err) {
    console.error("Yo! callback status check failed:", err);
    return c.json({ received: true, matched: true, changed: false });
  }
});

/**
 * Real Flutterwave webhook target (`https://api.tumaffe.online/v1/payments/flutterwave/callback`
 * registered in the Flutterwave dashboard, not a request param). Same two
 * rules as the Yo! callback above: the `verif-hash` header has to match
 * the configured secret, and the body only tells us *which* transaction to
 * re-check — the status itself is always read back from Flutterwave's own
 * verify endpoint, never trusted from the webhook payload directly.
 */
paymentRoutes.post("/payments/flutterwave/callback", async (c) => {
  if (!(await verifyWebhookSignature(c.req.header("verif-hash")))) {
    console.warn("Rejected unauthenticated Flutterwave callback from", c.req.header("cf-connecting-ip") ?? "unknown");
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = (await c.req.json().catch(() => ({}))) as { data?: { tx_ref?: string } };
  const reference = (body.data?.tx_ref ?? "").trim();
  if (!reference) return c.json({ received: true, matched: false });

  const res = await db.execute({
    sql: "SELECT * FROM payments WHERE provider_ref = ? OR id = ? LIMIT 1",
    args: [reference, reference],
  });
  const payment = res.rows[0] as Row | undefined;
  if (!payment) return c.json({ received: true, matched: false });
  if (payment.status !== "pending") return c.json({ received: true, matched: true, changed: false });

  try {
    const changed = await applyPaymentStatus(payment, "flutterwave-callback");
    return c.json({ received: true, matched: true, changed });
  } catch (err) {
    console.error("Flutterwave callback status check failed:", err);
    return c.json({ received: true, matched: true, changed: false });
  }
});
