import { Hono, type Context } from "hono";
import { z } from "zod";
import type { InArgs } from "@libsql/client";
import { db } from "../db/client.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { haversineKm } from "../lib/geo.js";
import { newId, newPin } from "../lib/ids.js";
import { legacyPayout, supportsLegacyOrder } from "../lib/rollback-compat.js";
import { baseMimeType, extensionForMime } from "../lib/mime.js";
import { consume, tooManyRequests } from "../lib/ratelimit.js";
import { getDeliverySettings, getMatchingSettings, getMaxOrderValue, getPlatformEnvironment } from "../lib/settings.js";
import { notifyUser } from "../lib/webpush.js";
import { currentVisibilityRadiusKm, orderMatchPoint, parseDbTimestamp } from "./matching.js";
import { redactOrder } from "./visibility.js";
import type { MatchingMode, MobileMoneyNetwork } from "@tuma/shared";
import { initiateCollection, mobileMoneyNetworkLabel, UnsupportedNetworkError } from "../payments/service.js";
import { getR2Bucket, uploadResponseHeaders } from "../storage/r2.js";
import { appBaseUrl } from "../verify/service.js";
import { payFromWallet } from "../wallet/service.js";

function paymentReturnUrl(orderId: string): string {
  return `${appBaseUrl("customer")}/orders/${orderId}?payment_return=1`;
}

export const orderRoutes = new Hono();
orderRoutes.use("*", requireAuth);
orderRoutes.use("*", async (c, next) => {
  const match = c.req.path.match(/\/orders\/([^/]+)(?:\/|$)/);
  if (match && !["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const order = await getOrder(match[1]);
    if (order && !supportsLegacyOrder(order)) {
      return c.json({error: "service_unavailable", message: "This order is preserved, but its service is unavailable in the September 20 version."}, 409);
    }
  }
  await next();
});

type Row = Record<string, unknown>;

function formatAmount(n: number): string {
  return `UGX ${n.toLocaleString("en-UG")}`;
}

/** SQLite's own `datetime('now')` format — computed here (instead of just
 * writing it in SQL) so the same value can be reused on the in-memory
 * message objects handed back in the same response, without a re-read. */
function sqliteNow(): string {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

async function logEvent(orderId: string, stage: string, note: string, actorId: string) {
  await db.execute({
    sql: "INSERT INTO order_events (id, order_id, stage, note, actor_id) VALUES (?, ?, ?, ?, ?)",
    args: [newId("evt"), orderId, stage, note, actorId],
  });
}

async function getOrder(orderId: string): Promise<Row | undefined> {
  const res = await db.execute({
    sql: `SELECT o.*, c.name as customer_name, r.name as rider_name FROM orders o
          LEFT JOIN users c ON c.id = o.customer_id
          LEFT JOIN users r ON r.id = o.rider_id
          WHERE o.id = ?`,
    args: [orderId],
  });
  return res.rows[0] as Row | undefined;
}

async function touchOrder(orderId: string, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = ?`).join(", ");
  await db.execute({
    sql: `UPDATE orders SET ${setClause}, updated_at = datetime('now') WHERE id = ?`,
    args: [...keys.map((k) => fields[k]), orderId] as unknown as InArgs,
  });
}

/** Throws a Response-shaped error the caller returns directly. */
class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

function assertCustomer(order: Row, userId: string) {
  if (order.customer_id !== userId) throw new HttpError(403, "Not your order");
}
function assertRider(order: Row, userId: string) {
  if (order.rider_id !== userId) throw new HttpError(403, "Not your assigned order");
}

/**
 * Strips the handover PIN out of every order this router returns, for
 * everyone except the order's own customer (and admins).
 *
 * Done here rather than at each `c.json({ order })` because there are a
 * dozen of those and the next route someone adds would quietly leak it
 * again. The PIN is the customer's proof that they physically received the
 * goods — a rider who can read it can claim a handover that never happened,
 * which is the single thing the PIN exists to prevent.
 */
orderRoutes.use("*", async (c, next) => {
  await next();
  const user = c.get("user");
  if (!user || user.role === "admin") return;
  if (!c.res.headers.get("content-type")?.includes("application/json")) return;

  // Cheap check before the expensive one. This router also serves chat
  // history, which can be long and never contains a PIN — reading the text
  // and looking for the field beats parsing and re-serializing every
  // response just in case.
  const text = await c.res
    .clone()
    .text()
    .catch(() => "");
  if (!text.includes("pin_code")) return;

  let body: { order?: Row; orders?: Row[] } | null;
  try {
    body = JSON.parse(text) as { order?: Row; orders?: Row[] };
  } catch {
    return;
  }
  if (!body || typeof body !== "object") return;

  const strip = (order: Row | undefined) => {
    if (!order || order.customer_id === user.sub || !("pin_code" in order)) return order;
    const { pin_code: _pin, ...rest } = order;
    return rest;
  };

  const hadOrder = body.order !== undefined;
  const hadOrders = Array.isArray(body.orders);
  if (!hadOrder && !hadOrders) return;

  const next_ = {
    ...body,
    ...(hadOrder ? { order: strip(body.order) } : {}),
    ...(hadOrders ? { orders: (body.orders as Row[]).map((o) => strip(o) as Row) } : {}),
  };
  c.res = new Response(JSON.stringify(next_), c.res);
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const createListSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  items: z
    .array(
      z.object({
        name: z.string().min(1).max(120),
        quantity: z.number().int().positive().default(1),
        unitCost: z.number().int().nonnegative().optional(),
        note: z.string().max(240).optional(),
      }),
    )
    .default([]),
});

orderRoutes.post("/lists", async (c) => {
  const user = c.get("user");
  const parsed = createListSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const listId = newId("list");
  const title = parsed.data.title?.trim() || "New shopping list";
  await db.execute({
    sql: "INSERT INTO lists (id, customer_id, title, status, environment) VALUES (?, ?, ?, 'draft', ?)",
    args: [listId, user.sub, title, await getPlatformEnvironment()],
  });
  for (const item of parsed.data.items) {
    await db.execute({
      sql: "INSERT INTO list_items (id, list_id, name, quantity, unit_price, note) VALUES (?, ?, ?, ?, ?, ?)",
      args: [newId("item"), listId, item.name, item.quantity, item.unitCost ?? null, item.note ?? null],
    });
  }

  return c.json(
    {
      id: listId,
      listId,
      title,
      status: "draft",
      itemCount: parsed.data.items.length,
      createdAt: new Date().toISOString(),
      nextPath: `/orders/${listId}/create`,
    },
    201,
  );
});

orderRoutes.get("/lists/recent", async (c) => {
  const user = c.get("user");
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "10") || 10, 50));
  const res = await db.execute({
    sql: `SELECT l.*, (SELECT COUNT(*) FROM list_items WHERE list_id = l.id) as item_count,
                 o.id as order_id, o.rider_id as rider_id, o.destination_area as destination_area,
                 r.first_name as rider_first_name, r.profile_photo_key as rider_photo_key,
                 u.name as rider_full_name
          FROM lists l
          LEFT JOIN orders o ON o.id = (SELECT id FROM orders WHERE list_id = l.id ORDER BY updated_at DESC LIMIT 1)
          LEFT JOIN riders r ON r.user_id = o.rider_id
          LEFT JOIN users u ON u.id = o.rider_id
          WHERE l.customer_hidden = 0 AND l.customer_id = ? AND l.environment = ? ORDER BY l.updated_at DESC LIMIT ?`,
    args: [user.sub, await getPlatformEnvironment(), limit],
  });
  return c.json({
    lists: res.rows.map((r) => {
      const fullName = (r.rider_full_name as string | null)?.trim();
      const riderFirstName = (r.rider_first_name as string | null) ?? (fullName ? fullName.split(/\s+/)[0] : null);
      return {
        id: r.id,
        listId: r.id,
        title: r.title,
        status: r.status,
        itemCount: r.item_count,
        updatedAt: r.updated_at,
        orderId: r.order_id ?? null,
        riderId: r.rider_id ?? null,
        riderFirstName: r.rider_id ? riderFirstName : null,
        riderHasPhoto: !!r.rider_photo_key,
        area: r.destination_area ?? null,
      };
    }),
  });
});

orderRoutes.get("/lists/:id", async (c) => {
  const id = c.req.param("id");
  const list = await db.execute({ sql: "SELECT * FROM lists WHERE id = ?", args: [id] });
  const row = list.rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.customer_id !== c.get("user").sub) return c.json({ error: "forbidden" }, 403);
  const items = await db.execute({ sql: "SELECT * FROM list_items WHERE list_id = ?", args: [id] });
  return c.json({ list: row, items: items.rows });
});

// ---------------------------------------------------------------------------
// Orders — create / read
// ---------------------------------------------------------------------------

const createOrderSchema = z.object({
  listId: z.string(),
  type: z.enum(["shopping", "parcel"]).default("shopping"),
  pickupArea: z.string().max(120).optional(),
  pickupAddress: z.string().max(240).optional(),
  pickupLat: z.number().optional(),
  pickupLng: z.number().optional(),
  destinationArea: z.string().max(120).optional(),
  destinationAddress: z.string().max(240).optional(),
  destinationLat: z.number().optional(),
  destinationLng: z.number().optional(),
  paymentRail: z.enum(["escrow", "float"]).default("escrow"),
  estimatedTotal: z.number().int().nonnegative().optional(),
});

orderRoutes.post("/orders", async (c) => {
  const user = c.get("user");
  const parsed = createOrderSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
  const d = parsed.data;

  const list = await db.execute({
    sql: "SELECT * FROM lists WHERE id = ?",
    args: [d.listId],
  });
  const listRow = list.rows[0];
  if (!listRow) return c.json({ error: "list_not_found" }, 404);
  if (listRow.customer_id !== user.sub) return c.json({ error: "forbidden" }, 403);

  // A parcel ride's cost is distance × the admin-set rate per km, computed
  // from pickup/destination coords whenever both were pinned on the map —
  // this always wins over any client-supplied estimate.
  //
  // Shopping orders have no pickup point (the "shop" is wherever the rider
  // goes), so there's no ride distance to price this way. The customer's own
  // estimate stands — but it becomes the amount escrow charges their mobile
  // money, so the server doesn't simply write down whatever arrived in the
  // request: it prefers the priced list when there is one, and refuses a
  // figure above the platform ceiling either way.
  let distanceKm: number | null = null;
  let estimatedTotal = d.estimatedTotal ?? null;
  // The delivery-fee portion of estimatedTotal, stored separately since
  // substitutions/fee proposals only ever adjust the items portion — see
  // migrations/0025_order_delivery_fee.sql.
  let deliveryFee: number | null = null;
  if (d.type === "parcel" && d.pickupLat != null && d.pickupLng != null && d.destinationLat != null && d.destinationLng != null) {
    distanceKm = haversineKm(d.pickupLat, d.pickupLng, d.destinationLat, d.destinationLng);
    const { deliveryRatePerKm } = await getDeliverySettings();
    estimatedTotal = Math.round(distanceKm * deliveryRatePerKm);
    // A parcel ride has no items — its whole total IS the delivery fee.
    deliveryFee = estimatedTotal;
  } else if (d.type === "shopping") {
    const priced = await db.execute({
      sql: `SELECT COUNT(*) AS total, COUNT(unit_price) AS priced,
                   COALESCE(SUM(quantity * unit_price), 0) AS sum_priced
            FROM list_items WHERE list_id = ?`,
      args: [d.listId],
    });
    const row = priced.rows[0] as Row | undefined;
    const itemCount = Number(row?.total ?? 0);
    const pricedCount = Number(row?.priced ?? 0);
    const { shoppingDeliveryFee } = await getDeliverySettings();
    deliveryFee = shoppingDeliveryFee;
    // Every item carries a price → the list itself is the quote, and the
    // client's separate estimate is redundant at best. Either way, the
    // flat delivery fee is added on top of the items cost.
    const itemsTotal = itemCount > 0 && pricedCount === itemCount ? Number(row?.sum_priced ?? 0) : (d.estimatedTotal ?? 0);
    estimatedTotal = itemsTotal + shoppingDeliveryFee;
  }

  if (estimatedTotal != null) {
    const maxOrderValue = await getMaxOrderValue();
    if (estimatedTotal > maxOrderValue) {
      return c.json(
        {
          error: "order_value_too_high",
          message: `Orders are capped at ${formatAmount(maxOrderValue)}. Please split this into smaller orders.`,
        },
        400,
      );
    }
  }

  // Which matching mode governs this order: the customer's own standing
  // preference, if admin currently allows it — otherwise whichever mode
  // admin put first. Stamped once at creation so it can't shift mid-flight
  // if either setting changes later. nearest_window gets a short collection
  // window; customer_selects gets a longer safety-net deadline so the order
  // still resolves even if the customer never picks (see ./matching.js and
  // the /orders/:id/match auto-resolve logic).
  const { enabledModes, nearestWindowSeconds, maxAssignmentMinutes } = await getMatchingSettings();
  const userRow = await db.execute({ sql: "SELECT default_matching_mode FROM users WHERE id = ?", args: [user.sub] });
  const preferredMode = userRow.rows[0]?.default_matching_mode as MatchingMode | null | undefined;
  const matchingMode: MatchingMode = preferredMode && enabledModes.includes(preferredMode) ? preferredMode : enabledModes[0];
  const matchingDeadlineAt =
    matchingMode === "nearest_window"
      ? new Date(Date.now() + nearestWindowSeconds * 1000).toISOString()
      : matchingMode === "customer_selects"
        ? new Date(Date.now() + maxAssignmentMinutes * 60 * 1000).toISOString()
        : null;

  const orderId = newId("ord");
  // Inherits the list's own environment rather than re-reading whatever's
  // currently active — keeps a list+order pair consistent even if an admin
  // flips platform_environment in the gap between the two requests.
  const orderEnvironment = (listRow.environment as string | undefined) === "sandbox" ? "sandbox" : "live";
  await db.execute({
    sql: `INSERT INTO orders (
            id, list_id, customer_id, stage, type, payment_rail, estimated_total, delivery_fee,
            pickup_area, pickup_address, pickup_lat, pickup_lng,
            destination_area, destination_address, destination_lat, destination_lng, distance_km,
            matching_mode, matching_deadline_at, environment
          )
          VALUES (?, ?, ?, 'Create', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      orderId,
      d.listId,
      user.sub,
      d.type,
      d.paymentRail,
      estimatedTotal,
      deliveryFee,
      d.pickupArea ?? null,
      d.pickupAddress ?? null,
      d.pickupLat ?? null,
      d.pickupLng ?? null,
      d.destinationArea ?? null,
      d.destinationAddress ?? null,
      d.destinationLat ?? null,
      d.destinationLng ?? null,
      distanceKm,
      matchingMode,
      matchingDeadlineAt,
      orderEnvironment,
    ],
  });
  await db.execute({
    sql: "UPDATE lists SET status = 'active', updated_at = datetime('now') WHERE id = ?",
    args: [parsed.data.listId],
  });
  await logEvent(orderId, "Create", "Order created", user.sub);

  const order = await getOrder(orderId);
  return c.json({ order }, 201);
});

orderRoutes.get("/orders/active", async (c) => {
  const user = c.get("user");
  const res = await db.execute({
    sql: `SELECT o.*, u.name as customer_name FROM orders o
          LEFT JOIN users u ON u.id = o.customer_id
          WHERE o.customer_id = ? AND o.stage NOT IN ('Settle', 'Cancelled') AND o.environment = ?
          ORDER BY o.updated_at DESC LIMIT 1`,
    args: [user.sub, await getPlatformEnvironment()],
  });
  return c.json({ activeOrder: res.rows[0] ?? null });
});

orderRoutes.get("/orders/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  const [items, events, substitutions, payments, rating, feeProposals] = await Promise.all([
    db.execute({ sql: "SELECT * FROM list_items WHERE list_id = ?", args: [order.list_id as string] }),
    db.execute({ sql: "SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC", args: [id] }),
    db.execute({ sql: "SELECT * FROM substitutions WHERE order_id = ? ORDER BY created_at ASC", args: [id] }),
    db.execute({ sql: "SELECT * FROM payments WHERE order_id = ? ORDER BY created_at ASC", args: [id] }),
    db.execute({ sql: "SELECT rating, comment, recommended FROM order_ratings WHERE order_id = ?", args: [id] }),
    db.execute({ sql: "SELECT * FROM fee_proposals WHERE order_id = ? ORDER BY created_at ASC", args: [id] }),
  ]);

  return c.json({
    order: redactOrder(order, user),
    items: items.rows,
    events: events.rows,
    substitutions: substitutions.rows,
    payments: payments.rows,
    rating: rating.rows[0] ?? null,
    feeProposals: feeProposals.rows,
  });
});

// ---------------------------------------------------------------------------
// Voice note — spoken context a typed list can miss (units, brand, exactly
// which shelf/shop). Attached by the customer, playable by whoever can
// already see the order.
// ---------------------------------------------------------------------------

const MAX_VOICE_NOTE_BYTES = 10 * 1024 * 1024;
const ALLOWED_VOICE_NOTE_MIME = new Set(["audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav"]);

orderRoutes.post("/orders/:id/voice-note", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return c.json({ error: "missing_audio" }, 400);
  if (!ALLOWED_VOICE_NOTE_MIME.has(baseMimeType(file.type))) return c.json({ error: "unsupported_file_type" }, 400);
  if (file.size > MAX_VOICE_NOTE_BYTES) return c.json({ error: "file_too_large" }, 400);

  const ext = extensionForMime(file.type, "webm");
  const key = `orders/${id}/voice-note.${ext}`;
  const bucket = getR2Bucket();
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  await touchOrder(id, { voice_note_key: key });
  await logEvent(id, order.stage as string, "Customer attached a voice note", user.sub);

  return c.json({ order: await getOrder(id) });
});

orderRoutes.get("/orders/:id/voice-note", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  const key = order.voice_note_key as string | null;
  if (!key) return c.json({ error: "not_found" }, 404);

  const bucket = getR2Bucket();
  const object = await bucket.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

  return new Response(object.body, {
    headers: uploadResponseHeaders(object.httpMetadata?.contentType, "audio/webm"),
  });
});

// ---------------------------------------------------------------------------
// Matching preference — a customer's standing choice of how riders get
// assigned to their orders (see ../lib/settings.js for the admin-side
// enable/disable and MatchingMode in @tuma/shared for the three modes).
// Only takes effect for whichever modes admin currently has enabled; a
// preference for a mode that's since been disabled falls back silently to
// admin's first enabled mode at order-creation time.
// ---------------------------------------------------------------------------

const matchingPreferenceSchema = z.object({
  defaultMatchingMode: z.enum(["first_to_claim", "nearest_window", "customer_selects"]).nullable(),
});

orderRoutes.put("/me/matching-preference", async (c) => {
  const user = c.get("user");
  const parsed = matchingPreferenceSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  await db.execute({
    sql: "UPDATE users SET default_matching_mode = ?, updated_at = datetime('now') WHERE id = ?",
    args: [parsed.data.defaultMatchingMode, user.sub],
  });

  return c.json({ defaultMatchingMode: parsed.data.defaultMatchingMode });
});

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

/**
 * Assigns a rider atomically (conditional UPDATE — loses the race harmlessly
 * if someone else got there first) and logs it. Shared by every path that
 * can end in an assignment: the first_to_claim auto-poll and claim button,
 * the nearest_window auto-resolve, and the customer_selects pick.
 */
async function assignRider(
  id: string,
  order: Row,
  riderId: string,
  riderName: string,
  outOfRange: boolean,
): Promise<boolean> {
  const nextStage = order.payment_rail === "float" ? "Shop" : "Match";
  const result = await db.execute({
    sql: `UPDATE orders SET rider_id = ?, stage = ?, matched_out_of_range = ?, updated_at = datetime('now')
          WHERE id = ? AND rider_id IS NULL AND stage IN ('Create', 'Match')`,
    args: [riderId, nextStage, outOfRange ? 1 : 0, id],
  });
  if (result.rowsAffected === 0) return false;

  // Anything the customer sent before a rider existed was stored with a null
  // rider_id, and every chat query since works off the customer/rider pair —
  // so without this those messages drop out of the conversation the moment
  // it gets a second participant, which is exactly when someone would look
  // for them. Adopt them into the thread that just formed.
  await db.execute({
    sql: "UPDATE chat_messages SET rider_id = ? WHERE order_id = ? AND rider_id IS NULL",
    args: [riderId, id],
  });

  await logEvent(
    id,
    "Match",
    outOfRange ? `Matched with rider ${riderName} (out of normal range)` : `Matched with rider ${riderName}`,
    riderId,
  );
  if (order.payment_rail === "float") {
    await logEvent(id, "Fund", "Cash rail — rider fronting funds, no payment needed upfront", riderId);
  }
  return true;
}

/**
 * Finds the best rider to auto-assign right now, exactly the way the
 * original single-mode matcher did: nearest rider within the currently-open
 * staged-radius tier, falling back (once every tier's had its turn) to a
 * same-area match or any available rider. Used as first_to_claim's auto-poll
 * backstop, and as the nearest_window / customer_selects safety net once
 * their deadline passes with no (or no usable) applicants.
 */
async function findAutoMatchCandidate(
  id: string,
  order: Row,
): Promise<{ riderId: string; riderName: string; outOfRange: boolean } | null> {
  const { serviceRangeKm } = await getDeliverySettings();
  const matchPoint = orderMatchPoint(order);
  const visibleRadiusKm = currentVisibilityRadiusKm(order.updated_at as string);
  const fullyOpen = visibleRadiusKm == null;

  const eligible = await db.execute({
    sql: `SELECT u.id, u.name, r.stage_lat, r.stage_lng, r.area FROM riders r JOIN users u ON u.id = r.user_id
          WHERE r.verified = 1 AND r.is_online = 1
          AND u.id NOT IN (
            SELECT rider_id FROM orders WHERE rider_id IS NOT NULL AND stage NOT IN ('Settle', 'Cancelled') AND environment = ?
          )
          AND u.id NOT IN (SELECT rider_id FROM order_rider_exclusions WHERE order_id = ?)`,
    args: [order.environment as string, id],
  });

  let nearestKnown: { row: Row; distanceKm: number } | null = null;
  const unknownLocation: Row[] = [];
  for (const row of eligible.rows as Row[]) {
    const riderLat = row.stage_lat as number | null;
    const riderLng = row.stage_lng as number | null;
    if (matchPoint && riderLat != null && riderLng != null) {
      const distanceKm = haversineKm(matchPoint.lat, matchPoint.lng, riderLat, riderLng);
      if (!fullyOpen && distanceKm > (visibleRadiusKm as number)) continue; // not their turn yet
      if (!nearestKnown || distanceKm < nearestKnown.distanceKm) nearestKnown = { row, distanceKm };
    } else {
      unknownLocation.push(row);
    }
  }

  if (nearestKnown) {
    return { riderId: nearestKnown.row.id as string, riderName: nearestKnown.row.name as string, outOfRange: nearestKnown.distanceKm > serviceRangeKm };
  }
  if (fullyOpen || !matchPoint) {
    const area = order.destination_area as string | null;
    const candidate = (area ? unknownLocation.find((row) => row.area === area) : undefined) ?? unknownLocation[0];
    if (candidate) {
      return { riderId: candidate.id as string, riderName: candidate.name as string, outOfRange: !area || candidate.area !== area };
    }
  }
  return null;
}

orderRoutes.post("/orders/:id/match", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  // Normally an unmatched order is in "Create". A funded order whose rider
  // cancelled is left in "Match" with rider_id cleared instead of being
  // rewound to "Create" — that would re-expose the funding step even though
  // the customer already paid — so it's matchable again too.
  const canMatch = order.stage === "Create" || (order.stage === "Match" && !order.rider_id);
  if (!canMatch) {
    return c.json({ error: "invalid_stage", message: `Cannot match from stage ${order.stage}` }, 409);
  }

  const mode = order.matching_mode as MatchingMode;

  if (mode === "customer_selects") {
    // The customer picks (see /orders/:id/applicants) — this poll only ever
    // acts as the safety net once the order's max-assignment deadline (set
    // at creation) has passed with nobody chosen yet.
    const deadline = order.matching_deadline_at as string | null;
    if (!deadline || Date.now() < parseDbTimestamp(deadline).getTime()) {
      return c.json({ order });
    }
  }

  if (mode === "nearest_window") {
    const deadline = order.matching_deadline_at as string | null;
    if (deadline && Date.now() < parseDbTimestamp(deadline).getTime()) {
      return c.json({ order }); // still collecting applicants
    }
    // Window's up — assign whoever applied nearest so far.
    const applicants = await db.execute({
      sql: `SELECT oa.rider_id, u.name, oa.distance_km FROM order_applications oa
            JOIN users u ON u.id = oa.rider_id
            WHERE oa.order_id = ? AND oa.status = 'pending' ORDER BY oa.distance_km ASC LIMIT 1`,
      args: [id],
    });
    const best = applicants.rows[0] as Row | undefined;
    if (best) {
      const { serviceRangeKm } = await getDeliverySettings();
      const distanceKm = best.distance_km as number | null;
      const outOfRange = distanceKm != null && distanceKm > serviceRangeKm;
      const bestRiderId = best.rider_id as string;
      const assigned = await assignRider(id, order, bestRiderId, best.name as string, outOfRange);
      if (assigned) {
        await db.execute({
          sql: "UPDATE order_applications SET status = 'selected' WHERE order_id = ? AND rider_id = ?",
          args: [id, bestRiderId],
        });
        await db.execute({
          sql: "UPDATE order_applications SET status = 'declined' WHERE order_id = ? AND rider_id != ? AND status = 'pending'",
          args: [id, bestRiderId],
        });
      }
      return c.json({ order: await getOrder(id) });
    }
    // Nobody's applied yet — extend the window rather than falling back
    // immediately, unless the overall SLA ceiling has now been reached.
    const { maxAssignmentMinutes, nearestWindowSeconds } = await getMatchingSettings();
    const ceilingReached =
      Date.now() - parseDbTimestamp(order.created_at as string).getTime() > maxAssignmentMinutes * 60 * 1000;
    if (!ceilingReached) {
      await touchOrder(id, { matching_deadline_at: new Date(Date.now() + nearestWindowSeconds * 1000).toISOString() });
      return c.json({ order: await getOrder(id) });
    }
    // Ceiling reached with zero applicants — fall through to the general
    // auto-match fallback below rather than leaving the customer stuck.
  }

  // first_to_claim's own auto-poll backstop, and the fallback for
  // nearest_window/customer_selects once their safety net is reached.
  const found = await findAutoMatchCandidate(id, order);
  if (!found) {
    return c.json({ error: "no_riders_available", message: "No verified riders online right now" }, 409);
  }
  await assignRider(id, order, found.riderId, found.riderName, found.outOfRange);
  return c.json({ order: await getOrder(id) });
});

/**
 * A rider actively taking an unmatched "first_to_claim" job from their
 * available-jobs list (see GET /riders/jobs/available) — the primary way
 * those orders get assigned, with the auto-match poll above as a backstop
 * for one nobody's claimed yet. Same staged-radius rule applies here so a
 * rider can't jump the queue by hitting this directly before it's their
 * tier's turn. Orders in another matching mode use /apply instead.
 */
orderRoutes.post("/orders/:id/claim", requireRole("rider"), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.rider_id) {
    return c.json({ error: "already_claimed", message: "Another rider already took this job" }, 409);
  }
  const canClaim = order.stage === "Create" || (order.stage === "Match" && !order.rider_id);
  if (!canClaim) {
    return c.json({ error: "invalid_stage", message: `Cannot claim from stage ${order.stage}` }, 409);
  }
  if (order.matching_mode !== "first_to_claim") {
    return c.json({ error: "wrong_mode", message: "This order takes applications instead — use /apply" }, 409);
  }

  const excluded = await db.execute({
    sql: "SELECT 1 FROM order_rider_exclusions WHERE order_id = ? AND rider_id = ?",
    args: [id, user.sub],
  });
  if (excluded.rows.length > 0) {
    return c.json({ error: "not_eligible", message: "You previously declined this order" }, 403);
  }

  const riderRes = await db.execute({
    sql: `SELECT r.verified, r.is_online, r.stage_lat, r.stage_lng, u.name FROM riders r
          JOIN users u ON u.id = r.user_id WHERE r.user_id = ?`,
    args: [user.sub],
  });
  const rider = riderRes.rows[0] as Row | undefined;
  if (!rider?.verified) return c.json({ error: "not_verified" }, 403);
  if (!rider.is_online) return c.json({ error: "not_online", message: "Go online to claim jobs" }, 409);

  const { serviceRangeKm } = await getDeliverySettings();
  const matchPoint = orderMatchPoint(order);
  const riderLat = rider.stage_lat as number | null;
  const riderLng = rider.stage_lng as number | null;
  const distanceKm =
    matchPoint && riderLat != null && riderLng != null
      ? haversineKm(matchPoint.lat, matchPoint.lng, riderLat, riderLng)
      : null;

  if (distanceKm != null) {
    const visibleRadiusKm = currentVisibilityRadiusKm(order.updated_at as string);
    if (visibleRadiusKm != null && distanceKm > visibleRadiusKm) {
      return c.json(
        { error: "not_yet_visible", message: "This order isn't open to your area yet — try again shortly" },
        409,
      );
    }
  }
  const outOfRange = distanceKm != null && distanceKm > serviceRangeKm;

  const assigned = await assignRider(id, order, user.sub, rider.name as string, outOfRange);
  if (!assigned) {
    return c.json({ error: "already_claimed", message: "Another rider already took this job" }, 409);
  }

  return c.json({ order: await getOrder(id) });
});

/**
 * A rider offering to take a "nearest_window" or "customer_selects" job —
 * unlike /claim, this doesn't assign the order outright. It just enters the
 * rider into the running: nearest_window auto-picks the closest applicant
 * once its collection window closes (see /orders/:id/match above),
 * customer_selects waits for the customer to pick (see /applicants below).
 */
orderRoutes.post("/orders/:id/apply", requireRole("rider"), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.rider_id) {
    return c.json({ error: "already_claimed", message: "This job has already been taken" }, 409);
  }
  const canApply = order.stage === "Create" || (order.stage === "Match" && !order.rider_id);
  if (!canApply) {
    return c.json({ error: "invalid_stage", message: `Cannot apply from stage ${order.stage}` }, 409);
  }
  if (order.matching_mode === "first_to_claim") {
    return c.json({ error: "wrong_mode", message: "This order is first-come-first-served — use /claim" }, 409);
  }

  const excluded = await db.execute({
    sql: "SELECT 1 FROM order_rider_exclusions WHERE order_id = ? AND rider_id = ?",
    args: [id, user.sub],
  });
  if (excluded.rows.length > 0) {
    return c.json({ error: "not_eligible", message: "You previously declined this order" }, 403);
  }

  const riderRes = await db.execute({
    sql: "SELECT verified, is_online, stage_lat, stage_lng FROM riders WHERE user_id = ?",
    args: [user.sub],
  });
  const rider = riderRes.rows[0] as Row | undefined;
  if (!rider?.verified) return c.json({ error: "not_verified" }, 403);
  if (!rider.is_online) return c.json({ error: "not_online", message: "Go online to apply for jobs" }, 409);

  const matchPoint = orderMatchPoint(order);
  const riderLat = rider.stage_lat as number | null;
  const riderLng = rider.stage_lng as number | null;
  const distanceKm =
    matchPoint && riderLat != null && riderLng != null
      ? haversineKm(matchPoint.lat, matchPoint.lng, riderLat, riderLng)
      : null;

  if (distanceKm != null) {
    const visibleRadiusKm = currentVisibilityRadiusKm(order.updated_at as string);
    if (visibleRadiusKm != null && distanceKm > visibleRadiusKm) {
      return c.json(
        { error: "not_yet_visible", message: "This order isn't open to your area yet — try again shortly" },
        409,
      );
    }
  }

  // status goes back to 'pending' on a repeat application, not just the
  // distance. When someone else gets picked every other applicant is marked
  // 'declined', and if that rider later cancels the job returns to the pool —
  // without this reset, anyone who applied the first time round would get an
  // "applied" confirmation while staying invisible to the customer, because
  // the applicant list only shows pending rows.
  await db.execute({
    sql: `INSERT INTO order_applications (id, order_id, rider_id, distance_km, status)
          VALUES (?, ?, ?, ?, 'pending')
          ON CONFLICT(order_id, rider_id) DO UPDATE SET distance_km = excluded.distance_km, status = 'pending'`,
    args: [newId("app"), id, user.sub, distanceKm],
  });

  return c.json({ ok: true });
});

/** The applicant pool for a "customer_selects" order — enough of each rider's track record to compare. */
orderRoutes.get("/orders/:id/applicants", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const { serviceRangeKm } = await getDeliverySettings();
  const applications = await db.execute({
    sql: `SELECT oa.rider_id, u.name, oa.distance_km FROM order_applications oa
          JOIN users u ON u.id = oa.rider_id
          WHERE oa.order_id = ? AND oa.status = 'pending' ORDER BY oa.distance_km ASC`,
    args: [id],
  });

  const applicants = await Promise.all(
    (applications.rows as Row[]).map(async (row) => {
      const riderId = row.rider_id as string;
      const [stats, comments] = await Promise.all([
        db.execute({
          sql: `SELECT AVG(orr.rating) as avg_rating, COUNT(*) as review_count, SUM(orr.recommended) as recommend_count
                FROM order_ratings orr JOIN orders o ON o.id = orr.order_id WHERE o.rider_id = ?`,
          args: [riderId],
        }),
        db.execute({
          sql: `SELECT orr.comment FROM order_ratings orr JOIN orders o ON o.id = orr.order_id
                WHERE o.rider_id = ? AND orr.comment IS NOT NULL ORDER BY orr.created_at DESC LIMIT 3`,
          args: [riderId],
        }),
      ]);
      const statsRow = stats.rows[0] as Row | undefined;
      const distanceKm = row.distance_km as number | null;
      return {
        riderId,
        riderName: row.name as string,
        distanceKm,
        outOfServiceRange: distanceKm != null && distanceKm > serviceRangeKm,
        avgRating: statsRow?.avg_rating != null ? Math.round((statsRow.avg_rating as number) * 10) / 10 : null,
        reviewCount: Number(statsRow?.review_count ?? 0),
        recommendCount: Number(statsRow?.recommend_count ?? 0),
        recentComments: (comments.rows as Row[]).map((r) => r.comment as string),
      };
    }),
  );

  return c.json({ applicants });
});

/** The customer's pick, for a "customer_selects" order — assigns that rider and turns away the rest. */
orderRoutes.post("/orders/:id/applicants/:riderId/select", async (c) => {
  const id = c.req.param("id");
  const riderId = c.req.param("riderId") as string;
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.rider_id) {
    return c.json({ error: "already_claimed", message: "This order already has a rider" }, 409);
  }

  const application = await db.execute({
    sql: "SELECT oa.distance_km, u.name FROM order_applications oa JOIN users u ON u.id = oa.rider_id WHERE oa.order_id = ? AND oa.rider_id = ? AND oa.status = 'pending'",
    args: [id, riderId],
  });
  const row = application.rows[0] as Row | undefined;
  if (!row) return c.json({ error: "not_found", message: "That rider hasn't applied for this order" }, 404);

  const { serviceRangeKm } = await getDeliverySettings();
  const distanceKm = row.distance_km as number | null;
  const outOfRange = distanceKm != null && distanceKm > serviceRangeKm;

  const assigned = await assignRider(id, order, riderId, row.name as string, outOfRange);
  if (!assigned) {
    return c.json({ error: "already_claimed", message: "This order already has a rider" }, 409);
  }
  await db.execute({
    sql: "UPDATE order_applications SET status = 'selected' WHERE order_id = ? AND rider_id = ?",
    args: [id, riderId],
  });
  await db.execute({
    sql: "UPDATE order_applications SET status = 'declined' WHERE order_id = ? AND rider_id != ? AND status = 'pending'",
    args: [id, riderId],
  });

  return c.json({ order: await getOrder(id) });
});

// ---------------------------------------------------------------------------
// Cancel — a rider backing out of a job they were matched to. The order
// drops back into the matching pool instead of being cancelled outright,
// and this rider is never offered it again.
// ---------------------------------------------------------------------------

const CANCELLABLE_STAGES = ["Match", "Fund", "Shop", "Substitute", "Approve", "Deliver"];

orderRoutes.post("/orders/:id/cancel", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (!CANCELLABLE_STAGES.includes(order.stage as string)) {
    return c.json({ error: "invalid_stage", message: `Cannot cancel from stage ${order.stage}` }, 409);
  }

  await db.execute({
    sql: "INSERT OR IGNORE INTO order_rider_exclusions (order_id, rider_id) VALUES (?, ?)",
    args: [id, user.sub],
  });

  // Money already collected? Skip back to "Match" (needs a new rider only) —
  // rewinding all the way to "Create" would re-expose the funding step and
  // risk a double charge. Otherwise a full "Create" rewind is safe.
  const paid = await db.execute({
    sql: "SELECT id FROM payments WHERE order_id = ? AND type = 'collection' AND status = 'successful' LIMIT 1",
    args: [id],
  });
  const nextStage = paid.rows.length > 0 ? "Match" : "Create";

  await touchOrder(id, { rider_id: null, stage: nextStage, matched_out_of_range: 0 });
  await logEvent(id, nextStage, "Rider cancelled — order returned to the job pool", user.sub);

  return c.json({ order: await getOrder(id) });
});

// ---------------------------------------------------------------------------
// Fund (escrow via mobile money collection, or float)
// ---------------------------------------------------------------------------

const fundSchema = z
  .object({
    msisdn: z.string().min(6).max(20).optional(),
    useWallet: z.boolean().optional(),
    // Pay from someone else's wallet instead of your own — only valid
    // when that owner has an active wallet_shares grant to this customer.
    walletOwnerId: z.string().optional(),
  })
  .refine((data) => !!data.msisdn || !!data.useWallet, { message: "Provide a mobile money number or pay from wallet" });

orderRoutes.post("/orders/:id/fund", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Match") {
    return c.json({ error: "invalid_stage", message: `Cannot fund from stage ${order.stage}` }, 409);
  }

  // final_total is set the moment a fee proposal or item substitution is
  // approved — charge that when present so an accepted pre-funding fee
  // change is actually what gets collected, not the original estimate.
  const amount = (order.final_total as number | null) ?? (order.estimated_total as number | null) ?? 0;

  if (order.payment_rail === "float") {
    // Float rail: rider fronts the cash, no escrow collection needed.
    await touchOrder(id, { stage: "Shop" });
    await logEvent(id, "Fund", "Float rail — rider fronting funds", user.sub);
    return c.json({ order: await getOrder(id), funded: true, rail: "float" });
  }

  const parsed = fundSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  if (parsed.data.useWallet) {
    let walletOwnerId = user.sub;
    if (parsed.data.walletOwnerId && parsed.data.walletOwnerId !== user.sub) {
      const share = await db.execute({
        sql: "SELECT 1 FROM wallet_shares WHERE wallet_id IS NULL AND owner_id = ? AND grantee_id = ? AND status = 'active'",
        args: [parsed.data.walletOwnerId, user.sub],
      });
      if (share.rows.length === 0) return c.json({ error: "wallet_not_shared" }, 403);
      walletOwnerId = parsed.data.walletOwnerId;
    }
    const sharedSpend = walletOwnerId !== user.sub;

    const paymentId = await payFromWallet({
      userId: walletOwnerId,
      amount,
      orderId: id,
      note: `Order ${id}`,
      actorId: sharedSpend ? user.sub : undefined,
      environment: order.environment as "live" | "sandbox",
    });
    if (!paymentId) return c.json({ error: "insufficient_wallet_balance" }, 409);

    await touchOrder(id, { stage: "Shop" });
    await logEvent(id, "Fund", sharedSpend ? "Paid from a shared wallet — shopping started" : "Paid from wallet — shopping started", user.sub);
    return c.json({ order: await getOrder(id), payment: { id: paymentId, status: "successful", network: null } });
  }

  const paymentId = newId("pay");
  let providerRef: string;
  let network: MobileMoneyNetwork | null;
  let provider: string;
  let redirectUrl: string | undefined;
  try {
    const initiated = await initiateCollection({
      referenceId: paymentId,
      msisdn: parsed.data.msisdn,
      amount,
      name: user.name,
      returnUrl: paymentReturnUrl(id),
      forceMock: order.environment === "sandbox",
    });
    providerRef = initiated.providerRef;
    network = initiated.network;
    provider = initiated.provider;
    redirectUrl = initiated.redirectUrl;
  } catch (err) {
    if (err instanceof UnsupportedNetworkError) {
      return c.json({ error: "unsupported_network", message: err.message }, 400);
    }
    console.error("Escrow collection request failed:", err);
    return c.json(
      { error: "payment_request_failed", message: "Couldn't reach mobile money just now. Please try again." },
      502,
    );
  }

  await db.execute({
    sql: `INSERT INTO payments (id, order_id, type, provider, provider_ref, msisdn, network, amount, currency, status)
          VALUES (?, ?, 'collection', ?, ?, ?, ?, ?, 'UGX', 'pending')`,
    args: [paymentId, id, provider, providerRef, parsed.data.msisdn ?? null, network, amount],
  });

  await touchOrder(id, { stage: "Fund" });
  await logEvent(
    id,
    "Fund",
    network ? `${mobileMoneyNetworkLabel(network)} collection requested` : "Collection requested",
    user.sub,
  );

  return c.json({
    order: await getOrder(id),
    payment: { id: paymentId, status: "pending", network },
    redirectUrl,
  });
});

// ---------------------------------------------------------------------------
// Shop / Substitute / Approve
// ---------------------------------------------------------------------------

const substituteSchema = z.object({
  itemId: z.string().optional(),
  originalName: z.string().min(1).max(120),
  substituteName: z.string().min(1).max(120),
  priceDelta: z.number().int().default(0),
});

orderRoutes.post("/orders/:id/substitutions", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Shop" && order.stage !== "Substitute") {
    return c.json({ error: "invalid_stage", message: `Cannot propose substitution from stage ${order.stage}` }, 409);
  }

  const parsed = substituteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const subId = newId("sub");
  await db.execute({
    sql: `INSERT INTO substitutions (id, order_id, item_id, original_name, substitute_name, price_delta)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [subId, id, parsed.data.itemId ?? null, parsed.data.originalName, parsed.data.substituteName, parsed.data.priceDelta],
  });
  await touchOrder(id, { stage: "Substitute" });
  await logEvent(id, "Substitute", `Proposed: ${parsed.data.originalName} → ${parsed.data.substituteName}`, user.sub);

  return c.json({ substitution: subId }, 201);
});

const batchSubstituteSchema = z.object({
  changes: z
    .array(
      z.object({
        itemId: z.string().optional(),
        originalName: z.string().min(1).max(120),
        substituteName: z.string().min(1).max(120),
        priceDelta: z.number().int().default(0),
      }),
    )
    .min(1)
    .max(50),
});

/** Same as POST /substitutions, but for several items at once — one review for the customer instead of many. */
orderRoutes.post("/orders/:id/substitutions/batch", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Shop" && order.stage !== "Substitute") {
    return c.json({ error: "invalid_stage", message: `Cannot propose changes from stage ${order.stage}` }, 409);
  }

  const parsed = batchSubstituteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const batchId = newId("batch");
  for (const change of parsed.data.changes) {
    await db.execute({
      sql: `INSERT INTO substitutions (id, order_id, item_id, original_name, substitute_name, price_delta, batch_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [newId("sub"), id, change.itemId ?? null, change.originalName, change.substituteName, change.priceDelta, batchId],
    });
  }
  await touchOrder(id, { stage: "Substitute" });
  const netDelta = parsed.data.changes.reduce((sum, ch) => sum + ch.priceDelta, 0);
  await logEvent(
    id,
    "Substitute",
    `Proposed ${parsed.data.changes.length} change(s) for approval (${netDelta >= 0 ? "+" : ""}${netDelta})`,
    user.sub,
  );

  return c.json({ batchId, order: await getOrder(id) }, 201);
});

orderRoutes.post("/orders/:id/substitutions/batch/:batchId/decision", async (c) => {
  const id = c.req.param("id");
  const batchId = c.req.param("batchId");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const batchRes = await db.execute({
    sql: "SELECT * FROM substitutions WHERE order_id = ? AND batch_id = ? AND status = 'pending'",
    args: [id, batchId],
  });
  const rows = batchRes.rows as Row[];
  if (rows.length === 0) return c.json({ error: "not_found" }, 404);

  const status = parsed.data.approve ? "approved" : "rejected";
  await db.execute({
    sql: "UPDATE substitutions SET status = ?, updated_at = datetime('now') WHERE order_id = ? AND batch_id = ?",
    args: [status, id, batchId],
  });

  if (parsed.data.approve) {
    const netDelta = rows.reduce((sum, r) => sum + ((r.price_delta as number) ?? 0), 0);
    if (netDelta) {
      const currentTotal = (order.final_total as number | null) ?? (order.estimated_total as number | null) ?? 0;
      await touchOrder(id, { final_total: currentTotal + netDelta });
    }
  }

  await logEvent(id, "Approve", `Batch of ${rows.length} change(s) ${status}`, user.sub);

  const remaining = await db.execute({
    sql: "SELECT COUNT(*) as n FROM substitutions WHERE order_id = ? AND status = 'pending'",
    args: [id],
  });
  if ((remaining.rows[0]?.n as number) === 0) {
    await touchOrder(id, { stage: "Approve" });
  }

  return c.json({ order: await getOrder(id) });
});

const decisionSchema = z.object({ approve: z.boolean() });

orderRoutes.post("/orders/:id/substitutions/:subId/decision", async (c) => {
  const id = c.req.param("id");
  const subId = c.req.param("subId");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const subRes = await db.execute({ sql: "SELECT * FROM substitutions WHERE id = ? AND order_id = ?", args: [subId, id] });
  const sub = subRes.rows[0];
  if (!sub) return c.json({ error: "not_found" }, 404);

  const status = parsed.data.approve ? "approved" : "rejected";
  await db.execute({
    sql: "UPDATE substitutions SET status = ?, updated_at = datetime('now') WHERE id = ?",
    args: [status, subId],
  });

  if (parsed.data.approve && sub.price_delta) {
    const currentTotal = (order.final_total as number | null) ?? (order.estimated_total as number | null) ?? 0;
    await touchOrder(id, { final_total: currentTotal + (sub.price_delta as number) });
  }

  await logEvent(id, "Approve", `Substitution ${status}: ${sub.substitute_name}`, user.sub);

  const remaining = await db.execute({
    sql: "SELECT COUNT(*) as n FROM substitutions WHERE order_id = ? AND status = 'pending'",
    args: [id],
  });
  if ((remaining.rows[0]?.n as number) === 0) {
    await touchOrder(id, { stage: "Approve" });
  }

  return c.json({ order: await getOrder(id) });
});

// ---------------------------------------------------------------------------
// Fee proposals — rider suggests a different total than the auto-calculated
// (or customer-entered) one; customer accepts or rejects it.
// ---------------------------------------------------------------------------

const proposeFeeSchema = z.object({
  proposedTotal: z.number().int().nonnegative(),
  reason: z.string().max(240).optional(),
});

orderRoutes.post("/orders/:id/fee-proposals", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage === "Create" || order.stage === "Settle") {
    return c.json({ error: "invalid_stage", message: `Cannot propose a fee from stage ${order.stage}` }, 409);
  }

  const parsed = proposeFeeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const previousTotal = (order.final_total as number | null) ?? (order.estimated_total as number | null) ?? 0;
  const proposalId = newId("fee");
  await db.execute({
    sql: `INSERT INTO fee_proposals (id, order_id, previous_total, proposed_total, reason)
          VALUES (?, ?, ?, ?, ?)`,
    args: [proposalId, id, previousTotal, parsed.data.proposedTotal, parsed.data.reason ?? null],
  });
  await logEvent(
    id,
    order.stage as string,
    `Rider suggested a new total: ${formatAmount(parsed.data.proposedTotal)} (was ${formatAmount(previousTotal)})`,
    user.sub,
  );

  return c.json({ proposalId, order: await getOrder(id) }, 201);
});

orderRoutes.post("/orders/:id/fee-proposals/:proposalId/decision", async (c) => {
  const id = c.req.param("id");
  const proposalId = c.req.param("proposalId");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const parsed = decisionSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const propRes = await db.execute({
    sql: "SELECT * FROM fee_proposals WHERE id = ? AND order_id = ? AND status = 'pending'",
    args: [proposalId, id],
  });
  const proposal = propRes.rows[0] as Row | undefined;
  if (!proposal) return c.json({ error: "not_found" }, 404);

  const status = parsed.data.approve ? "approved" : "rejected";
  await db.execute({
    sql: "UPDATE fee_proposals SET status = ?, updated_at = datetime('now') WHERE id = ?",
    args: [status, proposalId],
  });

  if (parsed.data.approve) {
    await touchOrder(id, { final_total: proposal.proposed_total });
  }
  await logEvent(
    id,
    order.stage as string,
    `Fee suggestion ${status}${parsed.data.approve ? ` — new total ${formatAmount(proposal.proposed_total as number)}` : ""}`,
    user.sub,
  );

  return c.json({ order: await getOrder(id) });
});

// A rider explaining a fee bump may not be comfortable typing it in
// English — this carries the reason as raw audio instead of transcribing
// it, since transcription of a non-English recording just produces
// gibberish text (see the order-level voice-note handling above, same
// reasoning). Sent as its own request right after the proposal is
// created, since the proposal itself is JSON and this is multipart.
orderRoutes.post("/orders/:id/fee-proposals/:proposalId/voice-note", async (c) => {
  const id = c.req.param("id");
  const proposalId = c.req.param("proposalId");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }

  const propRes = await db.execute({
    sql: "SELECT id FROM fee_proposals WHERE id = ? AND order_id = ?",
    args: [proposalId, id],
  });
  if (!propRes.rows[0]) return c.json({ error: "not_found" }, 404);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof File)) return c.json({ error: "missing_audio" }, 400);
  if (!ALLOWED_VOICE_NOTE_MIME.has(baseMimeType(file.type))) return c.json({ error: "unsupported_file_type" }, 400);
  if (file.size > MAX_VOICE_NOTE_BYTES) return c.json({ error: "file_too_large" }, 400);

  const ext = extensionForMime(file.type, "webm");
  const key = `orders/${id}/fee-proposals/${proposalId}/voice-note.${ext}`;
  const bucket = getR2Bucket();
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

  await db.execute({
    sql: "UPDATE fee_proposals SET reason_voice_key = ?, updated_at = datetime('now') WHERE id = ?",
    args: [key, proposalId],
  });

  return c.json({ order: await getOrder(id) });
});

orderRoutes.get("/orders/:id/fee-proposals/:proposalId/voice-note", async (c) => {
  const id = c.req.param("id");
  const proposalId = c.req.param("proposalId");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  const propRes = await db.execute({
    sql: "SELECT reason_voice_key FROM fee_proposals WHERE id = ? AND order_id = ?",
    args: [proposalId, id],
  });
  const key = (propRes.rows[0] as Row | undefined)?.reason_voice_key as string | null | undefined;
  if (!key) return c.json({ error: "not_found" }, 404);

  const bucket = getR2Bucket();
  const object = await bucket.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

  return new Response(object.body, {
    headers: uploadResponseHeaders(object.httpMetadata?.contentType, "audio/webm"),
  });
});

// ---------------------------------------------------------------------------
// Deliver / Handover / Settle
// ---------------------------------------------------------------------------

const deliverSchema = z.object({ etaMinutes: z.number().int().positive().optional() });

orderRoutes.post("/orders/:id/deliver", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (!["Shop", "Substitute", "Approve"].includes(order.stage as string)) {
    return c.json({ error: "invalid_stage", message: `Cannot start delivery from stage ${order.stage}` }, 409);
  }

  const parsed = deliverSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const pin = (order.pin_code as string | null) ?? newPin();
  await touchOrder(id, {
    stage: "Deliver",
    eta_minutes: parsed.data.etaMinutes ?? order.eta_minutes ?? 15,
    pin_code: pin,
  });
  await logEvent(id, "Deliver", "Rider en route", user.sub);

  return c.json({ order: await getOrder(id) });
});

/** The rider's own "I've arrived" tap — a distinct signal from starting
 * delivery, so the customer gets a fresh notification right when it
 * matters instead of just once, back when the rider set off. */
orderRoutes.post("/orders/:id/arrived", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertRider(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Deliver") {
    return c.json({ error: "invalid_stage", message: `Cannot mark arrived from stage ${order.stage}` }, 409);
  }

  await touchOrder(id, { stage: "Arrived" });
  await logEvent(id, "Arrived", "Rider arrived", user.sub);

  if (order.customer_id) {
    background(
      c,
      notifyUser(order.customer_id as string, {
        title: "Your rider has arrived",
        body: `${user.name || "Your rider"} is here with your ${order.type === "parcel" ? "parcel" : "order"}.`,
        url: `/orders/${id}`,
        tag: `order-${id}`,
      }),
    );
  }

  return c.json({ order: await getOrder(id) });
});

const handoverSchema = z.object({ pin: z.string().length(4) });

orderRoutes.post("/orders/:id/handover", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Deliver" && order.stage !== "Arrived") {
    return c.json({ error: "invalid_stage", message: `Cannot hand over from stage ${order.stage}` }, 409);
  }

  const parsed = handoverSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  if (parsed.data.pin !== order.pin_code) {
    return c.json({ error: "pin_mismatch" }, 400);
  }

  await touchOrder(id, { stage: "Handover" });
  await logEvent(id, "Handover", "PIN confirmed, handover complete", user.sub);

  return c.json({ order: await getOrder(id) });
});

// Settling is the rider's own confirmation that the job is done — the
// customer already gave theirs by entering the handover PIN. Requiring both
// before any money moves is the whole point of escrow: nothing releases
// from it until each side has confirmed. Escrow proceeds are credited to
// the rider's in-app wallet here rather than wired out immediately; they
// withdraw to mobile money separately, whenever they want. Cash-rail jobs
// have nothing to release — the rider already holds the cash — so this
// just closes the job out.
orderRoutes.post("/orders/:id/settle", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden", message: "Only the assigned rider can settle this order" }, 403);
  }
  if (order.stage !== "Handover") {
    return c.json({ error: "invalid_stage", message: `Cannot settle from stage ${order.stage}` }, 409);
  }

  const total = (order.final_total as number | null) ?? (order.estimated_total as number | null) ?? 0;

  let released = 0;
  if (order.payment_rail === "escrow" && order.rider_id) {
    // Release only what escrow actually holds, never `final_total`. An
    // approved fee proposal or substitution raises `final_total` after the
    // collection has already happened, with no top-up charged — paying that
    // out would hand the rider money the platform never received, which is
    // exactly the hole a rider colluding with a throwaway customer account
    // would mint from. Anything agreed above what was collected is a debt to
    // settle out of band, so it's logged rather than silently paid.
    const collectedRes = await db.execute({
      sql: `SELECT COALESCE(SUM(amount), 0) as collected FROM payments
            WHERE order_id = ? AND type = 'collection' AND status = 'successful'`,
      args: [id],
    });
    released = Number((collectedRes.rows[0] as Row)?.collected ?? 0);

    const feeResult = await db.execute({sql: "SELECT * FROM order_fees WHERE order_id = ?", args: [id]});
    const payout = legacyPayout(released, feeResult.rows[0] as Row | undefined);

    if (released > 0) {
      const balanceColumn = order.environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
      await db.execute({
        sql: `UPDATE riders SET ${balanceColumn} = ${balanceColumn} + ?, updated_at = datetime('now') WHERE user_id = ?`,
        args: [payout, order.rider_id as string],
      });
    }
    if (released < total) {
      await logEvent(
        id,
        "Settle",
        `Shortfall — ${formatAmount(total - released)} of the agreed total was never collected into escrow and was not paid out`,
        user.sub,
      );
    }
  }

  await touchOrder(id, { stage: "Settle", final_total: total });
  await db.execute({
    sql: "UPDATE lists SET status = 'delivered', updated_at = datetime('now') WHERE id = ?",
    args: [order.list_id as string],
  });
  await logEvent(
    id,
    "Settle",
    order.payment_rail === "escrow" ? `Order settled — ${formatAmount(released)} released to rider wallet` : "Order settled",
    user.sub,
  );

  return c.json({ order: await getOrder(id) });
});

// ---------------------------------------------------------------------------
// Rating — customer rates the rider once an order is delivered
// ---------------------------------------------------------------------------

const rateSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(500).optional(),
  recommended: z.boolean().optional().default(false),
});

orderRoutes.post("/orders/:id/rate", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  try {
    assertCustomer(order, user.sub);
  } catch (e) {
    if (e instanceof HttpError) return c.json({ error: e.message }, e.status);
    throw e;
  }
  if (order.stage !== "Settle") {
    return c.json({ error: "invalid_stage", message: "Can only rate a delivered order" }, 409);
  }
  if (!order.rider_id) {
    return c.json({ error: "no_rider" }, 409);
  }

  const parsed = rateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const existing = await db.execute({ sql: "SELECT id FROM order_ratings WHERE order_id = ?", args: [id] });
  if (existing.rows.length > 0) {
    return c.json({ error: "already_rated" }, 409);
  }

  await db.execute({
    sql: `INSERT INTO order_ratings (id, order_id, customer_id, rider_id, rating, comment, recommended) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId("rat"),
      id,
      user.sub,
      order.rider_id as string,
      parsed.data.rating,
      parsed.data.comment ?? null,
      parsed.data.recommended ? 1 : 0,
    ],
  });
  await db.execute({
    sql: `UPDATE riders SET rating = (SELECT AVG(rating) FROM order_ratings WHERE rider_id = ?), updated_at = datetime('now') WHERE user_id = ?`,
    args: [order.rider_id as string, order.rider_id as string],
  });

  return c.json({
    ok: true,
    rating: parsed.data.rating,
    comment: parsed.data.comment ?? null,
    recommended: parsed.data.recommended,
  });
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * The full conversation with this order's rider, not just this one order's
 * slice of it — a customer and rider who've shared several orders see one
 * continued thread, the way the messaging in any app they'd recognize
 * works. Falls back to just this order's own (likely empty) messages when
 * there's no rider assigned yet to pair with.
 */
/**
 * Loads a thread's full message history and, as a side effect, marks
 * anything the other party sent as delivered — the app's stand-in for "this
 * reached the recipient's device," since fetching the thread is the closest
 * signal available. Combined with `read` (derived from chat_reads, set when
 * the recipient's client calls POST .../chat/read), that's the full
 * sent → delivered → read progression the tick UI renders.
 *
 * Only meaningful when the viewer is actually one of the two participants —
 * an admin browsing a thread doesn't move anyone's delivery/read state.
 */
async function loadThreadMessages(customerId: string, riderId: string | null, viewerId: string): Promise<Row[]> {
  const res = riderId
    ? await db.execute({
        sql: "SELECT * FROM chat_messages WHERE customer_id = ? AND rider_id = ? ORDER BY created_at ASC",
        args: [customerId, riderId],
      })
    : await db.execute({
        sql: "SELECT * FROM chat_messages WHERE customer_id = ? AND rider_id IS NULL ORDER BY created_at ASC",
        args: [customerId],
      });
  const messages = res.rows as Row[];

  if (viewerId !== customerId && viewerId !== riderId) {
    return messages.map((m) => ({ ...m, read: false }));
  }

  const now = sqliteNow();
  const undeliveredIds = messages
    .filter((m) => m.sender_id !== viewerId && !m.delivered_at)
    .map((m) => m.id as string);
  if (undeliveredIds.length > 0) {
    const placeholders = undeliveredIds.map(() => "?").join(",");
    await db.execute({
      sql: `UPDATE chat_messages SET delivered_at = ? WHERE id IN (${placeholders})`,
      args: [now, ...undeliveredIds],
    });
  }
  const undelivered = new Set(undeliveredIds);

  const counterpartId = viewerId === customerId ? riderId : customerId;
  let counterpartReadAt: string | null = null;
  if (counterpartId) {
    const readRes = await db.execute({
      sql: "SELECT last_read_at FROM chat_reads WHERE user_id = ? AND counterpart_id = ?",
      args: [counterpartId, viewerId],
    });
    counterpartReadAt = (readRes.rows[0]?.last_read_at as string | undefined) ?? null;
  }

  return messages.map((m) => ({
    ...m,
    delivered_at: undelivered.has(m.id as string) ? now : m.delivered_at,
    read: m.sender_id === viewerId && !!counterpartReadAt && (m.created_at as string) <= (counterpartReadAt as string),
  }));
}

orderRoutes.get("/orders/:id/chat", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!order.rider_id) {
    const res = await db.execute({
      sql: "SELECT * FROM chat_messages WHERE order_id = ? ORDER BY created_at ASC",
      args: [id],
    });
    return c.json({ messages: (res.rows as Row[]).map((m) => ({ ...m, read: false })) });
  }
  const messages = await loadThreadMessages(order.customer_id as string, order.rider_id as string, user.sub);
  return c.json({ messages });
});

const chatSchema = z.object({ body: z.string().min(1).max(2000) });
const MAX_CHAT_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_CHAT_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Every photo or voice message is up to 6-10MB kept in R2 indefinitely, and
 * nothing deletes it — so an ordinary signed-in account can run up storage
 * at will. Both ceilings are well past what a real conversation uses in an
 * hour; they exist to stop a script, not a chatty customer. */
const CHAT_MEDIA_PER_HOUR = 40;
const CHAT_MESSAGES_PER_HOUR = 400;

/**
 * Text messages arrive as JSON; a photo or voice note arrives as multipart
 * form data instead (field `type`: "image" | "voice", field `file`) —
 * chosen by content-type so both share this one endpoint the way
 * apps/customer/components/OrderChat.tsx already expects.
 */
orderRoutes.post("/orders/:id/chat", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  const overall = await consume(`chat:${user.sub}`, CHAT_MESSAGES_PER_HOUR, 60 * 60);
  if (!overall.allowed) {
    return tooManyRequests(c, overall, "You're sending messages too quickly. Please try again shortly.");
  }

  if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
    const mediaQuota = await consume(`chat-media:${user.sub}`, CHAT_MEDIA_PER_HOUR, 60 * 60);
    if (!mediaQuota.allowed) {
      return tooManyRequests(c, mediaQuota, "You've sent a lot of attachments — please try again later.");
    }

    const form = await c.req.formData().catch(() => null);
    const file = form?.get("file");
    const type = form?.get("type");
    if (!(file instanceof File) || (type !== "image" && type !== "voice")) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const allowed = type === "image" ? ALLOWED_CHAT_IMAGE_MIME : ALLOWED_VOICE_NOTE_MIME;
    const maxBytes = type === "image" ? MAX_CHAT_IMAGE_BYTES : MAX_VOICE_NOTE_BYTES;
    if (!allowed.has(baseMimeType(file.type))) return c.json({ error: "unsupported_file_type" }, 400);
    if (file.size > maxBytes) return c.json({ error: "file_too_large" }, 400);

    const messageId = newId("msg");
    const ext = extensionForMime(file.type, type === "image" ? "jpg" : "webm");
    const key = `orders/${id}/chat/${messageId}.${ext}`;
    const bucket = getR2Bucket();
    await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });

    await db.execute({
      sql: `INSERT INTO chat_messages (id, order_id, sender_id, sender_role, body, type, media_key, customer_id, rider_id)
            VALUES (?, ?, ?, ?, '', ?, ?, ?, ?)`,
      args: [messageId, id, user.sub, user.role, type, key, order.customer_id as string, order.rider_id as string | null],
    });
    for (const recipientId of chatRecipientIds(order, user.sub, user.role)) {
      background(
        c,
        notifyUser(recipientId, {
          title: user.name || "New message",
          body: chatPreview(type, null),
          url: `/chat/${user.sub}`,
          tag: `chat-${order.customer_id}-${order.rider_id}`,
        }),
      );
    }
    return c.json({ id: messageId }, 201);
  }

  const parsed = chatSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const messageId = newId("msg");
  await db.execute({
    sql: `INSERT INTO chat_messages (id, order_id, sender_id, sender_role, body, type, customer_id, rider_id)
          VALUES (?, ?, ?, ?, ?, 'text', ?, ?)`,
    args: [messageId, id, user.sub, user.role, parsed.data.body, order.customer_id as string, order.rider_id as string | null],
  });
  for (const recipientId of chatRecipientIds(order, user.sub, user.role)) {
    background(
      c,
      notifyUser(recipientId, {
        title: user.name || "New message",
        body: chatPreview("text", parsed.data.body),
        url: `/chat/${user.sub}`,
        tag: `chat-${order.customer_id}-${order.rider_id}`,
      }),
    );
  }
  return c.json({ id: messageId }, 201);
});

/** Advances the caller's read pointer for this order's conversation to now
 * — clears the unread badge for whichever counterpart they share it with. */
orderRoutes.post("/orders/:id/chat/read", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  const order = await getOrder(id);
  if (!order) return c.json({ error: "not_found" }, 404);
  if (order.customer_id !== user.sub && order.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }

  const counterpartId = user.sub === order.customer_id ? (order.rider_id as string | null) : (order.customer_id as string);
  if (!counterpartId) return c.json({ ok: true });

  await db.execute({
    sql: `INSERT INTO chat_reads (user_id, counterpart_id, last_read_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(user_id, counterpart_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    args: [user.sub, counterpartId],
  });
  return c.json({ ok: true });
});

/**
 * Streams a chat photo or voice note from R2. Not scoped to a particular
 * order in the URL — a message shown in a thread view may belong to an
 * older order than whichever one's currently open (see GET /orders/:id/chat
 * above) — so access is checked against the message's own denormalized
 * customer_id/rider_id instead.
 */
orderRoutes.get("/chat/media/:messageId", async (c) => {
  const messageId = c.req.param("messageId") as string;
  const user = c.get("user");

  const res = await db.execute({
    sql: "SELECT media_key, customer_id, rider_id, sender_id, type, played_at FROM chat_messages WHERE id = ?",
    args: [messageId],
  });
  const row = res.rows[0] as Row | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.customer_id !== user.sub && row.rider_id !== user.sub && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  const key = row.media_key as string | null;
  if (!key) return c.json({ error: "not_found" }, 404);

  // Fetching the blob of a voice note is what "playing" it means client-side
  // (OrderChat only calls this on tap, never eagerly) — record it as played
  // the first time anyone other than the sender does, powering the
  // green/blue unplayed/played bubble color.
  if (row.type === "voice" && row.sender_id !== user.sub && !row.played_at) {
    background(c, db.execute({ sql: "UPDATE chat_messages SET played_at = datetime('now') WHERE id = ?", args: [messageId] }));
  }

  const bucket = getR2Bucket();
  const object = await bucket.get(key);
  if (!object) return c.json({ error: "not_found" }, 404);

  return new Response(object.body, {
    headers: uploadResponseHeaders(object.httpMetadata?.contentType, "application/octet-stream"),
  });
});

function chatPreview(type: unknown, body: unknown): string {
  if (type === "image") return "📷 Photo";
  if (type === "voice") return "🎤 Voice message";
  return (body as string | null) ?? "";
}

/** Who should be notified about a new message — the other party in a
 * customer/rider pair, or (a support intervention) both of them when the
 * sender is an admin. Empty when there's no counterpart yet (no rider
 * assigned) or the only other party is the sender themself. */
function chatRecipientIds(order: Row, senderId: string, senderRole: string): string[] {
  const customerId = order.customer_id as string;
  const riderId = order.rider_id as string | null;
  if (senderRole === "admin") {
    return [customerId, riderId].filter((rid): rid is string => !!rid && rid !== senderId);
  }
  const recipientId = senderId === customerId ? riderId : customerId;
  return recipientId ? [recipientId] : [];
}

/** Runs a best-effort background task past the point the response is sent.
 * On a Cloudflare Worker, ctx.waitUntil keeps the task alive after the
 * response returns; outside one (local Node dev) there's no such hook, so
 * it just runs unawaited — the process stays up on its own there. */
function background(c: Context, task: Promise<unknown>): void {
  const settled = task.catch((err) => console.error("Background task failed:", err));
  try {
    c.executionCtx.waitUntil(settled);
  } catch {
    void settled;
  }
}

/** Every counterpart this user has ever exchanged chat messages with, most recent first — powers the Chat tab's conversation list. */
orderRoutes.get("/chat/threads", async (c) => {
  const user = c.get("user");
  const isCustomer = user.role === "customer";

  const res = await db.execute(
    isCustomer
      ? {
          sql: `SELECT r.user_id as counterpart_id, u.name as counterpart_name, r.profile_photo_key,
                       MAX(cm.created_at) as last_at
                FROM chat_messages cm
                JOIN riders r ON r.user_id = cm.rider_id
                JOIN users u ON u.id = r.user_id
                WHERE cm.customer_id = ?
                GROUP BY r.user_id
                ORDER BY last_at DESC`,
          args: [user.sub],
        }
      : {
          sql: `SELECT cm.customer_id as counterpart_id, u.name as counterpart_name, u.profile_photo_key,
                       MAX(cm.created_at) as last_at
                FROM chat_messages cm
                JOIN users u ON u.id = cm.customer_id
                WHERE cm.rider_id = ?
                GROUP BY cm.customer_id
                ORDER BY last_at DESC`,
          args: [user.sub],
        },
  );

  const readsRes = await db.execute({
    sql: "SELECT counterpart_id, last_read_at FROM chat_reads WHERE user_id = ?",
    args: [user.sub],
  });
  const lastReadAt = new Map((readsRes.rows as Row[]).map((r) => [r.counterpart_id as string, r.last_read_at as string]));

  const threads = await Promise.all(
    (res.rows as Row[]).map(async (row) => {
      const counterpartId = row.counterpart_id as string;
      const [custId, ridId] = isCustomer ? [user.sub, counterpartId] : [counterpartId, user.sub];
      // Best-effort: this poll runs app-wide (BottomNav) while the user is
      // signed in at all, not just while a specific thread is open — the
      // broadest available "reached their device" signal for delivered ticks.
      background(
        c,
        db.execute({
          sql: "UPDATE chat_messages SET delivered_at = datetime('now') WHERE customer_id = ? AND rider_id = ? AND sender_id != ? AND delivered_at IS NULL",
          args: [custId, ridId, user.sub],
        }),
      );
      const lastRes = await db.execute({
        sql: isCustomer
          ? "SELECT type, body, sender_id FROM chat_messages WHERE customer_id = ? AND rider_id = ? ORDER BY created_at DESC LIMIT 1"
          : "SELECT type, body, sender_id FROM chat_messages WHERE rider_id = ? AND customer_id = ? ORDER BY created_at DESC LIMIT 1",
        args: [user.sub, counterpartId],
      });
      const last = lastRes.rows[0] as Row | undefined;
      const lastAt = row.last_at as string;
      const readAt = lastReadAt.get(counterpartId);
      const unread = last?.sender_id !== user.sub && (!readAt || lastAt > readAt);
      return {
        counterpartId,
        counterpartName: row.counterpart_name as string,
        counterpartHasPhoto: !!row.profile_photo_key,
        lastMessagePreview: chatPreview(last?.type, last?.body),
        lastMessageAt: lastAt,
        unread,
      };
    }),
  );

  return c.json({ threads });
});

/**
 * Opens a conversation by counterpart rather than by order — resolves the
 * most recent order shared with them (where any new message gets attached)
 * plus their display info and the full cross-order message history.
 */
orderRoutes.get("/chat/threads/:counterpartId", async (c) => {
  const counterpartId = c.req.param("counterpartId") as string;
  const user = c.get("user");
  const isCustomer = user.role === "customer";
  const customerId = isCustomer ? user.sub : counterpartId;
  const riderId = isCustomer ? counterpartId : user.sub;

  const orderRes = await db.execute({
    sql: "SELECT id FROM orders WHERE customer_id = ? AND rider_id = ? ORDER BY updated_at DESC LIMIT 1",
    args: [customerId, riderId],
  });
  const orderId = orderRes.rows[0]?.id as string | undefined;
  if (!orderId) return c.json({ error: "not_found" }, 404);

  const counterpartRes = await db.execute(
    isCustomer
      ? { sql: "SELECT u.name, r.profile_photo_key FROM users u LEFT JOIN riders r ON r.user_id = u.id WHERE u.id = ?", args: [counterpartId] }
      : { sql: "SELECT name, profile_photo_key FROM users WHERE id = ?", args: [counterpartId] },
  );
  const counterpart = counterpartRes.rows[0] as Row | undefined;
  if (!counterpart) return c.json({ error: "not_found" }, 404);

  const messages = await loadThreadMessages(customerId, riderId, user.sub);

  return c.json({
    orderId,
    counterpartName: counterpart.name,
    counterpartHasPhoto: !!counterpart.profile_photo_key,
    messages,
  });
});
