import { isRiderProfileComplete, type MobileMoneyNetwork, type Rider } from "@tuma/shared";
import { Hono } from "hono";
import { supportsLegacyOrder } from "../lib/rollback-compat.js";
import { z } from "zod";
import { logActivity } from "../admin/activity.js";
import { requirePermission } from "../admin/permissions.js";
import { db } from "../db/client.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { haversineKm } from "../lib/geo.js";
import { newId } from "../lib/ids.js";
import { baseMimeType, extensionForMime } from "../lib/mime.js";
import { clientIp } from "../lib/ratelimit.js";
import { getDeliverySettings, getPlatformEnvironment } from "../lib/settings.js";
import { currentVisibilityRadiusKm, orderMatchPoint } from "../orders/matching.js";
import { redactOrders, toOpenJob } from "../orders/visibility.js";
import { checkPaymentStatus, initiateDisbursement, UnsupportedNetworkError } from "../payments/service.js";
import { getR2Bucket, uploadResponseHeaders } from "../storage/r2.js";

export const riderRoutes = new Hono();
const walletRemoved = async (c: import("hono").Context) => c.json({error: "wallet_removed", message: "Wallets are no longer available."}, 410);
riderRoutes.use("/riders/me/wallet", requireAuth, walletRemoved);
riderRoutes.use("/riders/me/wallet/*", requireAuth, walletRemoved);

type Row = Record<string, unknown>;

const applySchema = z.object({
  area: z.string().max(120).optional(),
  vehicleInfo: z.string().max(120).optional(),
  momoMsisdn: z.string().min(6).max(20).optional(),
  firstName: z.string().min(1).max(60).optional(),
  lastName: z.string().min(1).max(60).optional(),
  email: z.string().email().max(120).optional(),
  altPhone: z.string().min(6).max(20).optional(),
  stageAddress: z.string().min(1).max(240).optional(),
  homeAddress: z.string().min(1).max(240).optional(),
  stageLat: z.number().optional(),
  stageLng: z.number().optional(),
  stageName: z.string().min(1).max(120).optional(),
  stageChairmanName: z.string().min(1).max(120).optional(),
  stageChairmanContact: z.string().min(6).max(20).optional(),
  emergencyContactName: z.string().min(1).max(120).optional(),
  emergencyContactPhone: z.string().min(6).max(20).optional(),
});

/** Rider self-registers/updates their profile. Verification stays manual (mock admin approval). */
riderRoutes.post("/riders/apply", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const parsed = applySchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const d = parsed.data;

  if (d.email) {
    await db.execute({
      sql: "UPDATE users SET email = ?, updated_at = datetime('now') WHERE id = ?",
      args: [d.email, user.sub],
    });
  }
  if (d.firstName && d.lastName) {
    await db.execute({
      sql: "UPDATE users SET name = ?, updated_at = datetime('now') WHERE id = ?",
      args: [`${d.firstName} ${d.lastName}`, user.sub],
    });
  }

  await db.execute({
    sql: `INSERT INTO riders (
            user_id, area, vehicle_info, momo_msisdn, first_name, last_name, alt_phone,
            stage_address, home_address, stage_lat, stage_lng, stage_name,
            stage_chairman_name, stage_chairman_contact, emergency_contact_name, emergency_contact_phone
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            area = excluded.area,
            vehicle_info = excluded.vehicle_info,
            momo_msisdn = excluded.momo_msisdn,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            alt_phone = excluded.alt_phone,
            stage_address = excluded.stage_address,
            home_address = excluded.home_address,
            stage_lat = excluded.stage_lat,
            stage_lng = excluded.stage_lng,
            stage_name = excluded.stage_name,
            stage_chairman_name = excluded.stage_chairman_name,
            stage_chairman_contact = excluded.stage_chairman_contact,
            emergency_contact_name = excluded.emergency_contact_name,
            emergency_contact_phone = excluded.emergency_contact_phone,
            updated_at = datetime('now')`,
    args: [
      user.sub,
      d.area ?? null,
      d.vehicleInfo ?? null,
      d.momoMsisdn ?? null,
      d.firstName ?? null,
      d.lastName ?? null,
      d.altPhone ?? null,
      d.stageAddress ?? null,
      d.homeAddress ?? null,
      d.stageLat ?? null,
      d.stageLng ?? null,
      d.stageName ?? null,
      d.stageChairmanName ?? null,
      d.stageChairmanContact ?? null,
      d.emergencyContactName ?? null,
      d.emergencyContactPhone ?? null,
    ],
  });

  const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [user.sub] });
  const rider = res.rows[0] as unknown as Rider;
  if (isRiderProfileComplete(rider) && !rider.profile_completed_at) {
    await db.execute({
      sql: "UPDATE riders SET profile_completed_at = datetime('now') WHERE user_id = ?",
      args: [user.sub],
    });
    rider.profile_completed_at = new Date().toISOString();
  }

  return c.json({ rider });
});

const MAX_ID_DOCUMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ID_MIME = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/** Uploads the rider's National ID scan to R2 for manual admin verification only — never served publicly. */
riderRoutes.post("/riders/id-document", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  if (!ALLOWED_ID_MIME.has(baseMimeType(file.type))) return c.json({ error: "unsupported_file_type" }, 400);
  if (file.size > MAX_ID_DOCUMENT_BYTES) return c.json({ error: "file_too_large" }, 400);

  const ext = extensionForMime(file.type, "bin");
  const key = `riders/${user.sub}/national-id.${ext}`;
  const bucket = getR2Bucket();
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  await db.execute({
    sql: "UPDATE riders SET national_id_key = ?, updated_at = datetime('now') WHERE user_id = ?",
    args: [key, user.sub],
  });

  const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [user.sub] });
  const rider = res.rows[0] as unknown as Rider;
  if (isRiderProfileComplete(rider) && !rider.profile_completed_at) {
    await db.execute({
      sql: "UPDATE riders SET profile_completed_at = datetime('now') WHERE user_id = ?",
      args: [user.sub],
    });
    rider.profile_completed_at = new Date().toISOString();
  }

  return c.json({ rider });
});

const MAX_PROFILE_PHOTO_BYTES = 4 * 1024 * 1024;
const ALLOWED_PHOTO_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Uploads the rider's own face photo — mandatory for profile completion
 * (see isRiderProfileComplete in @tuma/shared). Unlike the National ID scan,
 * this one is meant to be seen: it's what a customer sees on their order
 * once a rider takes it, so it builds the same trust a driver photo does in
 * any ride-hailing app. Served back via GET /riders/:userId/photo, not
 * fully public.
 */
riderRoutes.post("/riders/profile-photo", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "missing_file" }, 400);
  if (!ALLOWED_PHOTO_MIME.has(baseMimeType(file.type))) return c.json({ error: "unsupported_file_type" }, 400);
  if (file.size > MAX_PROFILE_PHOTO_BYTES) return c.json({ error: "file_too_large" }, 400);

  const ext = extensionForMime(file.type, "jpg");
  const key = `riders/${user.sub}/profile-photo.${ext}`;
  const bucket = getR2Bucket();
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  await db.execute({
    sql: "UPDATE riders SET profile_photo_key = ?, updated_at = datetime('now') WHERE user_id = ?",
    args: [key, user.sub],
  });

  const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [user.sub] });
  const rider = res.rows[0] as unknown as Rider;
  if (isRiderProfileComplete(rider) && !rider.profile_completed_at) {
    await db.execute({
      sql: "UPDATE riders SET profile_completed_at = datetime('now') WHERE user_id = ?",
      args: [user.sub],
    });
    rider.profile_completed_at = new Date().toISOString();
  }

  return c.json({ rider });
});

/**
 * Streams a rider's profile photo. Broader than the National ID endpoint on
 * purpose — a face photo is meant to build trust, not stay hidden — but
 * still not open to just anyone: the rider themself, admins, and a customer
 * who has (or has had) an order matched to this rider.
 */
riderRoutes.get("/riders/:userId/photo", requireAuth, async (c) => {
  const userId = c.req.param("userId") as string;
  const user = c.get("user");

  if (user.sub !== userId && user.role !== "admin") {
    const related = await db.execute({
      sql: "SELECT 1 FROM orders WHERE customer_id = ? AND rider_id = ? LIMIT 1",
      args: [user.sub, userId],
    });
    if (related.rows.length === 0) return c.json({ error: "forbidden" }, 403);
  }

  const res = await db.execute({ sql: "SELECT profile_photo_key FROM riders WHERE user_id = ?", args: [userId] });
  const key = res.rows[0]?.profile_photo_key as string | null | undefined;
  if (!key) return c.json({ error: "not_found" }, 404);

  const bucket = getR2Bucket();
  const object = await bucket.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

  return new Response(object.body, {
    headers: { ...uploadResponseHeaders(object.httpMetadata?.contentType, "image/jpeg"), "Cache-Control": "private, max-age=3600" },
  });
});

const statusSchema = z.object({ online: z.boolean() });

riderRoutes.post("/riders/status", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  await db.execute({
    sql: "UPDATE riders SET is_online = ?, updated_at = datetime('now') WHERE user_id = ?",
    args: [parsed.data.online ? 1 : 0, user.sub],
  });
  const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [user.sub] });
  if (res.rows.length === 0) return c.json({ error: "not_a_rider" }, 404);
  return c.json({ rider: res.rows[0] });
});

riderRoutes.get("/riders/me", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [user.sub] });
  return c.json({ rider: res.rows[0] ?? null });
});

/** Rider's own assigned orders (any stage before Settle). */
riderRoutes.get("/riders/me/orders", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const res = await db.execute({
    sql: `SELECT o.*, u.name as customer_name FROM orders o
          LEFT JOIN users u ON u.id = o.customer_id
          WHERE o.rider_id = ? AND o.environment = ? ORDER BY o.updated_at DESC`,
    args: [user.sub, await getPlatformEnvironment()],
  });
  return c.json({ orders: redactOrders(res.rows as Row[], user) });
});

/**
 * Unmatched orders open to this rider right now — every order eventually
 * shows up for every verified/online rider, but the staged radius broadcast
 * (see ../orders/matching.js) means the nearest riders see each one first:
 * 1km, then 2km, then 3km, then everyone regardless of distance. A rider
 * has to be online to see anything here, same as for auto-matching.
 */
riderRoutes.get("/riders/jobs/available", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const riderRes = await db.execute({
    sql: "SELECT verified, is_online, stage_lat, stage_lng FROM riders WHERE user_id = ?",
    args: [user.sub],
  });
  const rider = riderRes.rows[0] as Row | undefined;
  if (!rider?.verified || !rider.is_online) {
    return c.json({ jobs: [] });
  }

  const { serviceRangeKm } = await getDeliverySettings();
  const riderLat = rider.stage_lat as number | null;
  const riderLng = rider.stage_lng as number | null;

  const [res, appliedRes] = await Promise.all([
    db.execute({
      sql: `SELECT o.*, u.name as customer_name FROM orders o
            LEFT JOIN users u ON u.id = o.customer_id
            WHERE o.rider_id IS NULL AND o.stage IN ('Create', 'Match') AND o.environment = ?
            AND o.id NOT IN (SELECT order_id FROM order_rider_exclusions WHERE rider_id = ?)
            ORDER BY o.created_at ASC`,
      args: [await getPlatformEnvironment(), user.sub],
    }),
    db.execute({
      sql: "SELECT order_id FROM order_applications WHERE rider_id = ? AND status = 'pending'",
      args: [user.sub],
    }),
  ]);
  const appliedOrderIds = new Set((appliedRes.rows as Row[]).map((r) => r.order_id as string));

  const jobs = (res.rows as Row[])
    .filter(supportsLegacyOrder)
    .map((order) => {
      const matchPoint = orderMatchPoint(order);
      const distanceKm =
        matchPoint && riderLat != null && riderLng != null
          ? haversineKm(matchPoint.lat, matchPoint.lng, riderLat, riderLng)
          : null;
      const visibleRadiusKm = currentVisibilityRadiusKm(order.updated_at as string);
      const visible = distanceKm == null || visibleRadiusKm == null || distanceKm <= visibleRadiusKm;
      return {
        job: toOpenJob(order, {
          distanceKm: distanceKm != null ? Math.round(distanceKm * 10) / 10 : null,
          outOfServiceRange: distanceKm != null && distanceKm > serviceRangeKm,
          applied: appliedOrderIds.has(order.id as string),
        }),
        sortKey: distanceKm ?? Infinity,
        visible,
      };
    })
    .filter((entry) => entry.visible)
    .sort((a, b) => a.sortKey - b.sortKey);

  return c.json({ jobs: jobs.map((entry) => entry.job) });
});

/**
 * Item-level detail for a still-open job — the available-jobs feed itself
 * withholds this (see orders/visibility.ts: toOpenJob), since that feed
 * reaches every online rider including all the ones who never take it. A
 * rider actually deciding whether to claim or apply for one specific job
 * reasonably wants to see what's on the list first, so this exists as a
 * separate, deliberate lookup rather than widening the feed itself.
 * Same eligibility window as the feed: still unclaimed, still open
 * (Create/Match), and not one this rider's been excluded from.
 */
riderRoutes.get("/riders/jobs/:id/preview", requireAuth, requireRole("rider"), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");

  const riderRes = await db.execute({
    sql: "SELECT verified, is_online FROM riders WHERE user_id = ?",
    args: [user.sub],
  });
  const rider = riderRes.rows[0] as Row | undefined;
  if (!rider?.verified || !rider.is_online) {
    return c.json({ error: "forbidden" }, 403);
  }

  const orderRes = await db.execute({
    sql: "SELECT id, type, list_id, rider_id, stage FROM orders WHERE id = ?",
    args: [id],
  });
  const order = orderRes.rows[0] as Row | undefined;
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.rider_id || !["Create", "Match"].includes(order.stage as string)) {
    return c.json({ error: "not_available", message: "This job is no longer open." }, 409);
  }

  const excludedRes = await db.execute({
    sql: "SELECT 1 FROM order_rider_exclusions WHERE order_id = ? AND rider_id = ?",
    args: [id, user.sub],
  });
  if (excludedRes.rows.length > 0) {
    return c.json({ error: "not_available", message: "This job is no longer open." }, 409);
  }

  const items =
    order.type === "shopping"
      ? (
          await db.execute({
            sql: "SELECT id, list_id, name, quantity, note, unit_price FROM list_items WHERE list_id = ?",
            args: [order.list_id as string],
          })
        ).rows
      : [];

  return c.json({ items });
});

// ---------------------------------------------------------------------------
// Wallet — escrow payouts land here at Settle instead of going straight to
// mobile money; riders withdraw the balance out whenever they want.
// ---------------------------------------------------------------------------

riderRoutes.get("/riders/me/wallet", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const environment = await getPlatformEnvironment();
  const balanceColumn = environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const riderRes = await db.execute({
    sql: `SELECT ${balanceColumn} as wallet_balance FROM riders WHERE user_id = ?`,
    args: [user.sub],
  });
  const balance = (riderRes.rows[0]?.wallet_balance as number | undefined) ?? 0;
  const withdrawalsRes = await db.execute({
    sql: "SELECT * FROM wallet_withdrawals WHERE rider_id = ? AND environment = ? ORDER BY created_at DESC LIMIT 20",
    args: [user.sub, environment],
  });
  return c.json({ balance, withdrawals: withdrawalsRes.rows });
});

/**
 * Withdraws the entire current balance to the rider's mobile money number on
 * file. Always operates on whichever balance (live or sandbox) matches the
 * currently active platform environment — a sandbox withdrawal debits the
 * sandbox balance and its disbursement is forced through the mock adapter
 * (see ../payments/service.ts), so no sandbox activity can ever move real
 * money out to a real phone number, even with live credentials configured.
 */
riderRoutes.post("/riders/me/wallet/withdraw", requireAuth, requireRole("rider"), async (c) => {
  const user = c.get("user");
  const environment = await getPlatformEnvironment();
  const balanceColumn = environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
  const riderRes = await db.execute({
    sql: `SELECT ${balanceColumn} as wallet_balance, momo_msisdn FROM riders WHERE user_id = ?`,
    args: [user.sub],
  });
  const rider = riderRes.rows[0] as Row | undefined;
  if (!rider) return c.json({ error: "not_a_rider" }, 404);
  const balance = (rider.wallet_balance as number) ?? 0;
  const msisdn = rider.momo_msisdn as string | null;
  if (balance <= 0) return c.json({ error: "no_balance", message: "Nothing to withdraw yet" }, 409);
  if (!msisdn) {
    return c.json({ error: "no_mobile_money", message: "Add a mobile money number in your profile first" }, 409);
  }

  // Debit FIRST, conditional on the balance still being exactly what we just
  // read, and treat the row count as the lock. Two withdrawals racing each
  // other both see the same balance on the read above, but only one of them
  // can win this update — the loser is turned away having moved no money.
  // Doing it the other way round (disburse, then zero) lets both requests
  // pay out against the same balance, since Workers serves them concurrently.
  const debit = await db.execute({
    sql: `UPDATE riders SET ${balanceColumn} = 0, updated_at = datetime('now') WHERE user_id = ? AND ${balanceColumn} = ?`,
    args: [user.sub, balance],
  });
  if (debit.rowsAffected === 0) {
    return c.json({ error: "balance_changed", message: "Your balance just changed — reopen the wallet and try again" }, 409);
  }

  const withdrawalId = newId("wd");
  let providerRef: string;
  let network: MobileMoneyNetwork | null;
  let provider: string;
  try {
    const initiated = await initiateDisbursement({
      referenceId: withdrawalId,
      msisdn,
      amount: balance,
      forceMock: environment === "sandbox",
    });
    providerRef = initiated.providerRef;
    network = initiated.network;
    provider = initiated.provider;
  } catch (err) {
    // The debit already went through, so hand the money back before failing.
    await db.execute({
      sql: `UPDATE riders SET ${balanceColumn} = ${balanceColumn} + ?, updated_at = datetime('now') WHERE user_id = ?`,
      args: [balance, user.sub],
    });
    if (err instanceof UnsupportedNetworkError) {
      return c.json({ error: "unsupported_network", message: err.message }, 400);
    }
    console.error("Withdrawal request failed:", err);
    return c.json({ error: "withdrawal_request_failed", message: "Couldn't reach mobile money. Please try again." }, 502);
  }

  await db.execute({
    sql: `INSERT INTO wallet_withdrawals (id, rider_id, amount, provider, provider_ref, msisdn, network, status, environment)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [withdrawalId, user.sub, balance, provider, providerRef, msisdn, network, environment],
  });

  return c.json({ withdrawalId, amount: balance, status: "pending" }, 201);
});

/** Sandbox/mock testing has no public webhook target, so the client polls this instead. */
riderRoutes.get("/riders/me/wallet/withdrawals/:id/refresh", requireAuth, requireRole("rider"), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const res = await db.execute({
    sql: "SELECT * FROM wallet_withdrawals WHERE id = ? AND rider_id = ?",
    args: [id, user.sub],
  });
  const withdrawal = res.rows[0] as Row | undefined;
  if (!withdrawal) return c.json({ error: "not_found" }, 404);
  if (withdrawal.status !== "pending") return c.json({ withdrawal });

  try {
    const status = await checkPaymentStatus({
      provider: withdrawal.provider as string,
      provider_ref: withdrawal.provider_ref as string | null,
      created_at: withdrawal.created_at as string,
    });
    if (status === "successful") {
      await db.execute({
        sql: "UPDATE wallet_withdrawals SET status = 'successful', updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
    } else if (status === "failed") {
      await db.execute({
        sql: "UPDATE wallet_withdrawals SET status = 'failed', updated_at = datetime('now') WHERE id = ?",
        args: [id],
      });
      // Refund into whichever balance this specific withdrawal was debited
      // from (its own stored environment), not whatever's currently
      // active — the toggle could have flipped since it was requested.
      const balanceColumn = withdrawal.environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
      await db.execute({
        sql: `UPDATE riders SET ${balanceColumn} = ${balanceColumn} + ?, updated_at = datetime('now') WHERE user_id = ?`,
        args: [withdrawal.amount as number, user.sub],
      });
    }
    const updated = await db.execute({ sql: "SELECT * FROM wallet_withdrawals WHERE id = ?", args: [id] });
    return c.json({ withdrawal: updated.rows[0] });
  } catch (err) {
    console.error("Withdrawal status check failed:", err);
    return c.json(
      { error: "status_check_failed", message: "Couldn't check the payout status just now. Please try again." },
      502,
    );
  }
});

// ---------------------------------------------------------------------------
// Admin — mock manual KYC/verification (no real document/ID provider yet)
// ---------------------------------------------------------------------------

riderRoutes.get("/admin/riders", requireAuth, requireRole("admin"), requirePermission("riders.view"), async (c) => {
  const res = await db.execute(
    `SELECT u.id, u.name, u.phone, u.email, u.status, r.*
     FROM riders r JOIN users u ON u.id = r.user_id ORDER BY r.created_at DESC`,
  );
  return c.json({ riders: res.rows });
});

/** Streams a rider's National ID scan from R2 for manual admin review. Never a public route. */
riderRoutes.get(
  "/admin/riders/:userId/id-document",
  requireAuth,
  requireRole("admin"),
  requirePermission("riders.view"),
  async (c) => {
    const userId = c.req.param("userId") as string;
    const res = await db.execute({ sql: "SELECT national_id_key FROM riders WHERE user_id = ?", args: [userId] });
    const key = res.rows[0]?.national_id_key as string | null | undefined;
    if (!key) return c.json({ error: "not_found" }, 404);

    const bucket = getR2Bucket();
    const object = await bucket.get(key);
    if (!object) return c.json({ error: "not_found" }, 404);

    return new Response(object.body, {
      headers: uploadResponseHeaders(object.httpMetadata?.contentType, "application/octet-stream"),
    });
  },
);

const verifySchema = z.object({ verified: z.boolean() });

riderRoutes.post(
  "/admin/riders/:userId/verify",
  requireAuth,
  requireRole("admin"),
  requirePermission("riders.verify"),
  async (c) => {
    const userId = c.req.param("userId") as string;
    const user = c.get("user");
    const parsed = verifySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const before = await db.execute({
      sql: `SELECT r.verified, u.name FROM riders r JOIN users u ON u.id = r.user_id WHERE r.user_id = ?`,
      args: [userId],
    });
    const beforeRow = before.rows[0] as Row | undefined;
    if (!beforeRow) return c.json({ error: "not_found" }, 404);

    const result = await db.execute({
      sql: "UPDATE riders SET verified = ?, updated_at = datetime('now') WHERE user_id = ?",
      args: [parsed.data.verified ? 1 : 0, userId],
    });
    if (result.rowsAffected === 0) return c.json({ error: "not_found" }, 404);

    await logActivity({
      actor: user,
      action: "rider.verify",
      entityType: "rider",
      entityId: userId,
      summary: `${parsed.data.verified ? "Verified" : "Un-verified"} rider ${beforeRow.name as string}`,
      before: { verified: beforeRow.verified },
      after: { verified: parsed.data.verified ? 1 : 0 },
      revertible: true,
      ip: clientIp(c),
    });

    const res = await db.execute({ sql: "SELECT * FROM riders WHERE user_id = ?", args: [userId] });
    return c.json({ rider: res.rows[0] });
  },
);
