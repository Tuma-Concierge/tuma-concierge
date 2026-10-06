import { Hono } from "hono";
import { z } from "zod";
import type { InArgs } from "@libsql/client";
import { db } from "../db/client.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { getPlatformEnvironment, type PlatformEnvironment } from "../lib/settings.js";
import { paymentsIntegrationStatus } from "../payments/service.js";
import { getR2Bucket } from "../storage/r2.js";
import { logActivity, revertActivity } from "./activity.js";
import {
  ADMIN_ROLES,
  ADMIN_ROLE_LABELS,
  ADMIN_ROLE_DESCRIPTIONS,
  hasPermission,
  isAdminRole,
  requirePermission,
  requireSuperAdmin,
} from "./permissions.js";
import { countSuperAdmins, inviteStaff, listStaff, resetStaffPassword } from "./staff.js";
import { clientIp } from "../lib/ratelimit.js";
import { refundOrderToWallet } from "../wallet/service.js";

export const adminRoutes = new Hono();
// Scoped to /admin/* rather than "*" on purpose. This router is mounted on
// the shared /v1 prefix, so a "*" middleware here applies to every route
// registered after it — which made mount order in app.ts load-bearing, and
// a blanket admin gate landing on someone else's routes is a locked door
// in the wrong doorway. Every route in this file lives under /admin, so
// scoping the guard costs nothing and makes reordering harmless.
adminRoutes.use("/admin/*", requireAuth, requireRole("admin"));

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Platform overview
// ---------------------------------------------------------------------------

/** Every order/payment figure here is scoped to one environment — defaults
 * to whichever is currently active platform-wide, overridable with
 * ?environment=live|sandbox so an admin can check sandbox test activity
 * without flipping the live toggle just to look. */
function resolveViewEnvironment(c: { req: { query(name: string): string | undefined } }, active: PlatformEnvironment): PlatformEnvironment {
  const requested = c.req.query("environment");
  return requested === "live" || requested === "sandbox" ? requested : active;
}

adminRoutes.get("/admin/stats", requirePermission("stats.view"), async (c) => {
  const environment = resolveViewEnvironment(c, await getPlatformEnvironment());
  const [users, riders, ordersByStage, paymentsByStatus, settled] = await Promise.all([
    db.execute(
      `SELECT role, COUNT(*) as n FROM users WHERE role IN ('customer', 'rider') GROUP BY role`,
    ),
    db.execute(
      `SELECT
         SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) as verified,
         SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online
       FROM riders`,
    ),
    db.execute({ sql: `SELECT stage, COUNT(*) as n FROM orders WHERE environment = ? GROUP BY stage`, args: [environment] }),
    db.execute({
      sql: `SELECT p.status, COUNT(*) as n FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.environment = ? GROUP BY p.status`,
      args: [environment],
    }),
    db.execute({
      sql: `SELECT COALESCE(SUM(final_total), 0) as total FROM orders WHERE stage = 'Settle' AND environment = ?`,
      args: [environment],
    }),
  ]);

  const usersByRole: Record<string, number> = { customer: 0, rider: 0 };
  for (const row of users.rows as Row[]) {
    usersByRole[row.role as string] = row.n as number;
  }
  const riderCounts = (riders.rows[0] as Row) ?? { verified: 0, online: 0 };
  const stageCounts: Record<string, number> = {};
  for (const row of ordersByStage.rows as Row[]) {
    stageCounts[row.stage as string] = row.n as number;
  }
  const paymentCounts: Record<string, number> = { pending: 0, successful: 0, failed: 0 };
  for (const row of paymentsByStatus.rows as Row[]) {
    paymentCounts[row.status as string] = row.n as number;
  }

  return c.json({
    stats: {
      totalCustomers: usersByRole.customer ?? 0,
      totalRiders: usersByRole.rider ?? 0,
      verifiedRiders: Number(riderCounts.verified ?? 0),
      onlineRiders: Number(riderCounts.online ?? 0),
      ordersByStage: stageCounts,
      paymentsByStatus: paymentCounts,
      settledGmv: Number((settled.rows[0] as Row)?.total ?? 0),
    },
  });
});

adminRoutes.get("/admin/integrations", requirePermission("integrations.view"), async (c) => {
  let storageConfigured = true;
  try {
    getR2Bucket();
  } catch {
    storageConfigured = false;
  }

  const failed = await db.execute({
    sql: `SELECT p.id, p.order_id, p.type, p.amount, p.currency, p.msisdn, p.created_at
          FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.status = 'failed' AND o.environment = ?
          ORDER BY p.created_at DESC LIMIT 10`,
    args: [await getPlatformEnvironment()],
  });

  return c.json({
    integrations: {
      mobileMoney: await paymentsIntegrationStatus(),
      storage: { configured: storageConfigured },
    },
    recentFailedPayments: failed.rows,
  });
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

adminRoutes.get("/admin/customers", requirePermission("customers.view"), async (c) => {
  const q = c.req.query("q")?.trim();
  const environment = resolveViewEnvironment(c, await getPlatformEnvironment());
  const res = await db.execute(
    q
      ? {
          sql: `SELECT u.id, u.name, u.phone, u.email, u.status, u.created_at,
                  (SELECT COUNT(*) FROM orders WHERE customer_id = u.id AND environment = ?) as order_count
                FROM users u WHERE u.role = 'customer' AND (u.name LIKE ? OR u.phone LIKE ?)
                ORDER BY u.created_at DESC LIMIT 100`,
          args: [environment, `%${q}%`, `%${q}%`],
        }
      : {
          sql: `SELECT u.id, u.name, u.phone, u.email, u.status, u.created_at,
             (SELECT COUNT(*) FROM orders WHERE customer_id = u.id AND environment = ?) as order_count
           FROM users u WHERE u.role = 'customer' ORDER BY u.created_at DESC LIMIT 100`,
          args: [environment],
        },
  );
  return c.json({ customers: res.rows });
});

adminRoutes.get("/admin/customers/:id", requirePermission("customers.view"), async (c) => {
  const id = c.req.param("id") as string;
  const environment = resolveViewEnvironment(c, await getPlatformEnvironment());
  const userRes = await db.execute({
    sql: `SELECT id, name, phone, email, status, created_at FROM users WHERE id = ? AND role = 'customer'`,
    args: [id],
  });
  const customer = userRes.rows[0];
  if (!customer) return c.json({ error: "not_found" }, 404);

  const ordersRes = await db.execute({
    sql: `SELECT o.*, u.name as rider_name FROM orders o
          LEFT JOIN users u ON u.id = o.rider_id
          WHERE o.customer_id = ? AND o.environment = ? ORDER BY o.updated_at DESC`,
    args: [id, environment],
  });

  return c.json({ customer, orders: ordersRes.rows });
});

/**
 * Refunds an order's collected payment(s) back to the customer's wallet —
 * the standing mechanism for "refunds return to the wallet" without a
 * full self-service cancellation flow, which this app doesn't have yet.
 * Refunds at most what was actually collected, and only once per order.
 */
adminRoutes.post("/admin/orders/:id/refund-to-wallet", requirePermission("payments.manage"), async (c) => {
  const id = c.req.param("id") as string;
  const admin = c.get("user");

  const orderRes = await db.execute({ sql: "SELECT customer_id, environment FROM orders WHERE id = ?", args: [id] });
  const order = orderRes.rows[0] as Record<string, unknown> | undefined;
  if (!order) return c.json({ error: "not_found" }, 404);

  const result = await refundOrderToWallet({
    orderId: id,
    customerId: order.customer_id as string,
    actorId: admin.sub,
    environment: order.environment === "sandbox" ? "sandbox" : "live",
    note: `Refunded by ${admin.name || "an admin"}`,
  });
  if ("error" in result) {
    const message = result.error === "already_refunded" ? "This order has already been fully refunded" : "Nothing was collected on this order to refund";
    return c.json({ error: result.error, message }, 409);
  }

  await logActivity({
    actor: { sub: admin.sub, name: admin.name, adminRole: isAdminRole(admin.adminRole) ? admin.adminRole : null },
    action: "payments.refund_to_wallet",
    entityType: "order",
    entityId: id,
    summary: `Refunded UGX ${result.refunded.toLocaleString()} to the customer's wallet`,
    ip: clientIp(c),
  });

  return c.json({ ok: true, refunded: result.refunded });
});

// ---------------------------------------------------------------------------
// Orders (platform-wide, read only)
// ---------------------------------------------------------------------------

adminRoutes.get("/admin/orders", requirePermission("orders.view"), async (c) => {
  const stage = c.req.query("stage")?.trim();
  const type = c.req.query("type")?.trim();
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "30") || 30, 100));
  const environment = resolveViewEnvironment(c, await getPlatformEnvironment());

  const conditions: string[] = ["o.environment = ?"];
  const args: (string | number)[] = [environment];
  if (stage) {
    conditions.push("o.stage = ?");
    args.push(stage);
  }
  if (type) {
    conditions.push("o.type = ?");
    args.push(type);
  }
  const where = `WHERE ${conditions.join(" AND ")}`;
  args.push(limit);

  const res = await db.execute({
    sql: `SELECT o.*, c.name as customer_name, r.name as rider_name FROM orders o
          LEFT JOIN users c ON c.id = o.customer_id
          LEFT JOIN users r ON r.id = o.rider_id
          ${where}
          ORDER BY o.updated_at DESC LIMIT ?`,
    args: args as unknown as InArgs,
  });
  return c.json({ orders: res.rows });
});

// ---------------------------------------------------------------------------
// Account status (suspend / reactivate riders or customers)
// ---------------------------------------------------------------------------

const statusSchema = z.object({ status: z.enum(["active", "suspended"]) });

adminRoutes.post("/admin/users/:id/status", async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const existing = await db.execute({ sql: "SELECT id, name, role, status FROM users WHERE id = ?", args: [id] });
  const row = existing.rows[0] as Row | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.role === "admin") {
    return c.json(
      { error: "cannot_manage_admin", message: "Use /admin/staff to manage staff accounts" },
      400,
    );
  }
  // Which permission applies depends on who's being suspended — a
  // Customer Manager can't touch a rider's account and vice versa, so this
  // has to check the target's own role rather than a single fixed
  // permission for the whole route.
  const permission = row.role === "rider" ? "riders.manage" : "customers.manage";
  if (!hasPermission(user.adminRole, permission)) {
    return c.json({ error: "forbidden", message: "Your role doesn't include this action." }, 403);
  }

  // Suspending has to end sessions that already exist, not just block the
  // next login — otherwise someone signed in on their phone keeps working
  // normally for the rest of the token's life. requireAuth checks status on
  // every request, and sessions_valid_from covers the reinstate-then-suspend
  // case where an old token would otherwise come back to life.
  await db.execute({
    sql: `UPDATE users
          SET status = ?,
              sessions_valid_from = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE sessions_valid_from END,
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [parsed.data.status, parsed.data.status, id],
  });
  const res = await db.execute({
    sql: "SELECT id, name, phone, email, role, status FROM users WHERE id = ?",
    args: [id],
  });

  await logActivity({
    actor: user,
    action: "user.status",
    entityType: row.role as string,
    entityId: id,
    summary: `${parsed.data.status === "suspended" ? "Suspended" : "Reactivated"} ${row.role} ${row.name as string}`,
    before: { status: row.status },
    after: { status: parsed.data.status },
    revertible: true,
    ip: clientIp(c),
  });

  return c.json({ user: res.rows[0] });
});

// ---------------------------------------------------------------------------
// Staff accounts — invite, list, change role/status, reset password.
// Super Admin only: this is the one thing no other role gets a permission
// for, so it's checked directly rather than through hasPermission.
// ---------------------------------------------------------------------------

adminRoutes.get("/admin/staff", requireSuperAdmin(), async (c) => {
  return c.json({ staff: await listStaff() });
});

const inviteStaffSchema = z.object({
  name: z.string().min(1).max(80),
  email: z.string().email().max(160),
  phone: z.string().min(6).max(20).optional(),
  adminRole: z.enum(ADMIN_ROLES),
});

adminRoutes.post("/admin/staff", requireSuperAdmin(), async (c) => {
  const user = c.get("user");
  const parsed = inviteStaffSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const result = await inviteStaff({ ...parsed.data, invitedBy: user.sub });
  if (!result.ok) {
    return c.json({ error: result.error }, 409);
  }

  await logActivity({
    actor: user,
    action: "staff.invite",
    entityType: "user",
    entityId: result.user.id as string,
    summary: `Invited ${parsed.data.name} as ${ADMIN_ROLE_LABELS[parsed.data.adminRole]}`,
    after: { adminRole: parsed.data.adminRole, email: parsed.data.email },
    ip: clientIp(c),
  });

  const emailFailed = "_emailFailed" in result.user;
  return c.json(
    {
      staff: result.user,
      ...(emailFailed
        ? {
            emailFailed: true,
            tempPassword: (result.user as Row)._tempPassword,
            message: "The invite email failed to send — share this temporary password with them another way.",
          }
        : {}),
    },
    201,
  );
});

const changeRoleSchema = z.object({ adminRole: z.enum(ADMIN_ROLES) });

adminRoutes.post("/admin/staff/:id/role", requireSuperAdmin(), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const parsed = changeRoleSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  const existing = await db.execute({
    sql: "SELECT id, name, admin_role FROM users WHERE id = ? AND role = 'admin'",
    args: [id],
  });
  const row = existing.rows[0] as Row | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);

  // Never let the platform end up with zero active Super Admins — that's a
  // lockout nobody inside the system could undo.
  if (row.admin_role === "super_admin" && parsed.data.adminRole !== "super_admin") {
    const remaining = await countSuperAdmins(id);
    if (remaining === 0) {
      return c.json(
        { error: "last_super_admin", message: "At least one active Super Admin must remain." },
        400,
      );
    }
  }

  await db.execute({
    sql: "UPDATE users SET admin_role = ?, sessions_valid_from = datetime('now'), updated_at = datetime('now') WHERE id = ?",
    args: [parsed.data.adminRole, id],
  });

  await logActivity({
    actor: user,
    action: "staff.role_change",
    entityType: "user",
    entityId: id,
    summary: `Changed ${row.name as string}'s role from ${ADMIN_ROLE_LABELS[row.admin_role as keyof typeof ADMIN_ROLE_LABELS]} to ${ADMIN_ROLE_LABELS[parsed.data.adminRole]}`,
    before: { adminRole: row.admin_role },
    after: { adminRole: parsed.data.adminRole },
    revertible: true,
    ip: clientIp(c),
  });

  return c.json({ ok: true });
});

adminRoutes.post("/admin/staff/:id/status", requireSuperAdmin(), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

  if (id === user.sub) {
    return c.json({ error: "cannot_manage_self", message: "You can't change your own status here." }, 400);
  }

  const existing = await db.execute({
    sql: "SELECT id, name, status, admin_role FROM users WHERE id = ? AND role = 'admin'",
    args: [id],
  });
  const row = existing.rows[0] as Row | undefined;
  if (!row) return c.json({ error: "not_found" }, 404);

  if (parsed.data.status === "suspended" && row.admin_role === "super_admin") {
    const remaining = await countSuperAdmins(id);
    if (remaining === 0) {
      return c.json(
        { error: "last_super_admin", message: "At least one active Super Admin must remain." },
        400,
      );
    }
  }

  await db.execute({
    sql: `UPDATE users
          SET status = ?,
              sessions_valid_from = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE sessions_valid_from END,
              updated_at = datetime('now')
          WHERE id = ?`,
    args: [parsed.data.status, parsed.data.status, id],
  });

  await logActivity({
    actor: user,
    action: "staff.status",
    entityType: "user",
    entityId: id,
    summary: `${parsed.data.status === "suspended" ? "Suspended" : "Reactivated"} staff member ${row.name as string}`,
    before: { status: row.status },
    after: { status: parsed.data.status },
    revertible: true,
    ip: clientIp(c),
  });

  return c.json({ ok: true });
});

adminRoutes.post("/admin/staff/:id/reset-password", requireSuperAdmin(), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const result = await resetStaffPassword(id);
  if (!result.ok) return c.json({ error: result.error }, 404);

  await logActivity({
    actor: user,
    action: "staff.reset_password",
    entityType: "user",
    entityId: id,
    summary: `Reset password for staff member`,
    ip: clientIp(c),
  });

  return c.json(
    result.emailed
      ? { ok: true, emailed: true }
      : { ok: true, emailed: false, tempPassword: result.tempPassword, message: "No email on file — share this temporary password another way." },
  );
});

adminRoutes.get("/admin/staff/roles", requireSuperAdmin(), (c) => {
  return c.json({
    roles: ADMIN_ROLES.map((role) => ({ role, label: ADMIN_ROLE_LABELS[role], description: ADMIN_ROLE_DESCRIPTIONS[role] })),
  });
});

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

adminRoutes.get("/admin/activity", requirePermission("activity_log.view"), async (c) => {
  const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? "50") || 50, 200));
  const before = c.req.query("before")?.trim();

  const res = await db.execute(
    before
      ? {
          sql: `SELECT * FROM admin_activity_log WHERE created_at < ? ORDER BY created_at DESC LIMIT ?`,
          args: [before, limit],
        }
      : { sql: `SELECT * FROM admin_activity_log ORDER BY created_at DESC LIMIT ?`, args: [limit] },
  );
  return c.json({ entries: res.rows });
});

adminRoutes.post("/admin/activity/:id/revert", requireSuperAdmin(), async (c) => {
  const id = c.req.param("id") as string;
  const user = c.get("user");
  const result = await revertActivity(id, user);
  if (!result.ok) {
    const messages: Record<string, string> = {
      not_found: "That log entry doesn't exist.",
      not_revertible: "This action can't be reverted.",
      already_reverted: "This action has already been reverted.",
      no_handler: "This action type doesn't support reverting yet.",
    };
    return c.json({ error: result.error, message: messages[result.error] }, 400);
  }
  return c.json({ ok: true });
});
