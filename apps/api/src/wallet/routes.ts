import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { db } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { consume, tooManyRequests } from "../lib/ratelimit.js";
import { getPlatformEnvironment, getWalletSettings } from "../lib/settings.js";
import { checkPaymentStatus, initiateCollection, UnsupportedNetworkError } from "../payments/service.js";
import { appBaseUrl } from "../verify/service.js";
import { creditWallet, getWalletCap, resolveCustomerByIdentifier, transferWallet } from "./service.js";

export const walletRoutes = new Hono();
const walletRemoved = async (c: import("hono").Context) => c.json({error: "wallet_removed", message: "Wallets are no longer available. Pay by cash or mobile money."}, 410);
walletRoutes.use("/wallet", requireAuth, walletRemoved);
walletRoutes.use("/wallet/*", requireAuth, walletRemoved);

type Row = Record<string, unknown>;

/** Balance, cap/verification tier, and recent activity — everything the
 * wallet screen needs in one call. */
walletRoutes.get("/wallet", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const environment = await getPlatformEnvironment();
  const column = environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const [{ cap, verified }, balanceRes, ledgerRes] = await Promise.all([
    getWalletCap(user.sub),
    db.execute({ sql: `SELECT ${column} as wallet_balance FROM users WHERE id = ?`, args: [user.sub] }),
    // Joined so a transfer/shared-wallet entry can be labeled with an
    // actual name ("Sent to Grace", "Order payment by Grace") instead of
    // a bare user id — actor_id is who spent it when that's not the
    // wallet owner, counterparty_id is the other side of a transfer.
    db.execute({
      sql: `SELECT wl.*, actor.name as actor_name, cp.name as counterparty_name
            FROM wallet_ledger wl
            LEFT JOIN users actor ON actor.id = wl.actor_id
            LEFT JOIN users cp ON cp.id = wl.counterparty_id
            WHERE wl.wallet_id IS NULL AND wl.user_id = ? AND wl.environment = ?
            ORDER BY wl.created_at DESC LIMIT 50`,
      args: [user.sub, environment],
    }),
  ]);
  const balance = Number((balanceRes.rows[0] as Row)?.wallet_balance ?? 0);
  return c.json({ balance, cap, verified, ledger: ledgerRes.rows });
});

const topupSchema = z.object({
  amount: z.number().int().positive(),
  msisdn: z.string().min(6).max(20).optional(),
});

walletRoutes.post("/wallet/topup", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const parsed = topupSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const { amount, msisdn } = parsed.data;

  const environment = await getPlatformEnvironment();
  const column = environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const [{ cap }, settings, balanceRes] = await Promise.all([
    getWalletCap(user.sub),
    getWalletSettings(),
    db.execute({ sql: `SELECT ${column} as wallet_balance FROM users WHERE id = ?`, args: [user.sub] }),
  ]);
  if (amount > settings.maxTopup) {
    return c.json({ error: "topup_too_large", message: `A single top-up can't exceed UGX ${settings.maxTopup.toLocaleString()}` }, 400);
  }
  const balance = Number((balanceRes.rows[0] as Row)?.wallet_balance ?? 0);
  if (balance + amount > cap) {
    return c.json(
      { error: "cap_exceeded", message: `That would put your wallet over its UGX ${cap.toLocaleString()} balance limit` },
      400,
    );
  }

  const topupId = newId("wtu");
  try {
    const initiated = await initiateCollection({
      referenceId: topupId,
      msisdn,
      amount,
      name: user.name,
      returnUrl: `${appBaseUrl("customer")}/wallet?topup_return=${topupId}`,
      forceMock: environment === "sandbox",
    });

    await db.execute({
      sql: `INSERT INTO wallet_topups (id, user_id, amount, provider, provider_ref, method, msisdn, network, status, environment)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      args: [
        topupId,
        user.sub,
        amount,
        initiated.provider,
        initiated.providerRef,
        initiated.network ? "mobile_money" : "card",
        msisdn ?? null,
        initiated.network,
        environment,
      ],
    });

    return c.json({ topupId, status: "pending", network: initiated.network, redirectUrl: initiated.redirectUrl }, 201);
  } catch (err) {
    if (err instanceof UnsupportedNetworkError) {
      return c.json({ error: "unsupported_network", message: err.message }, 400);
    }
    console.error("Wallet top-up request failed:", err);
    return c.json({ error: "payment_request_failed", message: "Couldn't start that top-up just now. Please try again." }, 502);
  }
});

walletRoutes.get("/wallet/topups/:id/refresh", requireAuth, requireRole("customer"), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const res = await db.execute({ sql: "SELECT * FROM wallet_topups WHERE id = ? AND user_id = ?", args: [id, user.sub] });
  const topup = res.rows[0] as Row | undefined;
  if (!topup) return c.json({ error: "not_found" }, 404);
  if (topup.status !== "pending") return c.json({ topup });

  const status = await checkPaymentStatus({
    provider: topup.provider as string,
    provider_ref: topup.provider_ref as string | null,
    created_at: topup.created_at as string,
  });

  if (status === "pending") return c.json({ topup });

  if (status === "failed") {
    await db.execute({
      sql: "UPDATE wallet_topups SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
      args: [id],
    });
    return c.json({ topup: { ...topup, status: "failed" } });
  }

  // Race-guarded exactly like payments/routes.ts applyPaymentStatus(): only
  // the request that actually flips pending -> successful gets to credit
  // the wallet, so a poll landing at the same moment as a second poll (or
  // a future webhook) can't double-credit.
  const updated = await db.execute({
    sql: "UPDATE wallet_topups SET status = 'successful', updated_at = datetime('now') WHERE id = ? AND status = 'pending'",
    args: [id],
  });
  if ((updated.rowsAffected ?? 0) > 0) {
    await creditWallet(user.sub, topup.amount as number, {
      type: "topup",
      environment: topup.environment === "sandbox" ? "sandbox" : "live",
      topupId: id,
      note: "Wallet top-up",
    });
  }

  return c.json({ topup: { ...topup, status: "successful" } });
});

// ---------------------------------------------------------------------------
// Peer-to-peer transfers — still closed-loop (funds move between two
// customer wallets, never out to mobile money).
// ---------------------------------------------------------------------------

const transferSchema = z.object({
  recipient: z.string().min(3).max(200),
  amount: z.number().int().positive(),
  note: z.string().max(140).optional(),
});

walletRoutes.post("/wallet/transfer", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const parsed = transferSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const { recipient, amount, note } = parsed.data;

  // A phone/email lookup that moves money is an enumeration target —
  // rate-limited per sender same as everything else that guesses at
  // another account's identity (auth/routes.ts's login/reset limits).
  const quota = await consume(`wallet-transfer:${user.sub}`, 10, 60 * 60);
  if (!quota.allowed) return tooManyRequests(c, quota, "Too many transfers just now. Please try again later.");

  const target = await resolveCustomerByIdentifier(recipient);
  if (!target) {
    return c.json({ error: "recipient_not_found", message: "We couldn't find a Tuma customer with that phone number or email." }, 404);
  }
  if (target.id === user.sub) {
    return c.json({ error: "self_transfer", message: "You can't send money to your own wallet." }, 400);
  }

  const environment = await getPlatformEnvironment();
  const column = environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const [{ cap: recipientCap }, recipientBalanceRes] = await Promise.all([
    getWalletCap(target.id),
    db.execute({ sql: `SELECT ${column} as wallet_balance FROM users WHERE id = ?`, args: [target.id] }),
  ]);
  const recipientBalance = Number((recipientBalanceRes.rows[0] as Row)?.wallet_balance ?? 0);
  if (recipientBalance + amount > recipientCap) {
    return c.json(
      { error: "recipient_cap_exceeded", message: `That would put ${target.name}'s wallet over their balance limit.` },
      400,
    );
  }

  const result = await transferWallet({ fromUserId: user.sub, toUserId: target.id, amount, environment, note });
  if (!result) {
    return c.json({ error: "insufficient_balance", message: "You don't have enough in your wallet for that." }, 409);
  }

  return c.json({ balance: result.fromBalance, recipientName: target.name }, 201);
});

// ---------------------------------------------------------------------------
// Shared wallet access — ongoing, revocable "spend from my wallet on your
// own orders" grants between two customers. The balance always stays the
// owner's; an active grant just lets the grantee pay for their own orders
// out of it (see orders/routes.ts POST /orders/:id/fund's walletOwnerId).
// ---------------------------------------------------------------------------

const shareInviteSchema = z.object({ recipient: z.string().min(3).max(200) });

walletRoutes.post("/wallet/shares", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const parsed = shareInviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const quota = await consume(`wallet-share-invite:${user.sub}`, 10, 60 * 60);
  if (!quota.allowed) return tooManyRequests(c, quota, "Too many invites just now. Please try again later.");

  const target = await resolveCustomerByIdentifier(parsed.data.recipient);
  if (!target) {
    return c.json({ error: "recipient_not_found", message: "We couldn't find a Tuma customer with that phone number or email." }, 404);
  }
  if (target.id === user.sub) {
    return c.json({ error: "self_share", message: "You can't share your wallet with yourself." }, 400);
  }

  const existing = await db.execute({
    sql: "SELECT id FROM wallet_shares WHERE wallet_id IS NULL AND owner_id = ? AND grantee_id = ? AND status IN ('pending', 'active')",
    args: [user.sub, target.id],
  });
  if (existing.rows.length > 0) {
    return c.json({ error: "already_shared", message: `You've already shared your wallet with ${target.name}.` }, 409);
  }

  const id = newId("wsh");
  await db.execute({
    sql: "INSERT INTO wallet_shares (id, owner_id, grantee_id, status) VALUES (?, ?, ?, 'pending')",
    args: [id, user.sub, target.id],
  });
  return c.json({ id, granteeName: target.name, status: "pending" }, 201);
});

/** Everything the wallet screen needs to render both directions: shares
 * this customer has extended to others ("granted"), and shares extended
 * to them ("received") — pending ones to accept/decline, active ones to
 * spend from or walk away from. A pending owner's balance isn't included
 * (they haven't accepted yet); it only appears once status is "active". */
walletRoutes.get("/wallet/shares", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const balanceColumn = (await getPlatformEnvironment()) === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const [grantedRes, receivedRes] = await Promise.all([
    db.execute({
      sql: `SELECT ws.id, ws.grantee_id, u.name as grantee_name, ws.status, ws.created_at, ws.responded_at
            FROM wallet_shares ws JOIN users u ON u.id = ws.grantee_id
            WHERE ws.wallet_id IS NULL AND ws.owner_id = ? ORDER BY ws.created_at DESC`,
      args: [user.sub],
    }),
    db.execute({
      sql: `SELECT ws.id, ws.owner_id, u.name as owner_name, ws.status, ws.created_at, ws.responded_at,
                   u.${balanceColumn} as owner_balance
            FROM wallet_shares ws JOIN users u ON u.id = ws.owner_id
            WHERE ws.wallet_id IS NULL AND ws.grantee_id = ? ORDER BY ws.created_at DESC`,
      args: [user.sub],
    }),
  ]);
  const received = (receivedRes.rows as Row[]).map((r) => ({
    ...r,
    owner_balance: r.status === "active" ? r.owner_balance : null,
  }));
  return c.json({ granted: grantedRes.rows, received });
});

walletRoutes.post("/wallet/shares/:id/accept", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id") as string;
  const res = await db.execute({
    sql: "UPDATE wallet_shares SET status = 'active', responded_at = datetime('now') WHERE id = ? AND grantee_id = ? AND status = 'pending'",
    args: [id, user.sub],
  });
  if ((res.rowsAffected ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ status: "active" });
});

walletRoutes.post("/wallet/shares/:id/decline", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id") as string;
  const res = await db.execute({
    sql: "UPDATE wallet_shares SET status = 'declined', responded_at = datetime('now') WHERE id = ? AND grantee_id = ? AND status = 'pending'",
    args: [id, user.sub],
  });
  if ((res.rowsAffected ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ status: "declined" });
});

/** Either side can end an active (or still-pending) share — the owner
 * revoking access, or the grantee giving it up themselves. */
walletRoutes.post("/wallet/shares/:id/revoke", requireAuth, requireRole("customer"), async (c) => {
  const user = c.get("user");
  const id = c.req.param("id") as string;
  const res = await db.execute({
    sql: `UPDATE wallet_shares SET status = 'revoked', responded_at = datetime('now')
          WHERE id = ? AND (owner_id = ? OR grantee_id = ?) AND status IN ('pending', 'active')`,
    args: [id, user.sub, user.sub],
  });
  if ((res.rowsAffected ?? 0) === 0) return c.json({ error: "not_found" }, 404);
  return c.json({ status: "revoked" });
});
