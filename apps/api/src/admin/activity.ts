/**
 * The admin activity log — one row per staff action worth being able to
 * answer "who did this, and when" about, and (for a covered set of
 * actions) "what did it look like before, so we can put it back".
 */

import { db } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { setMatchingModesEnabled, setSetting } from "../lib/settings.js";
import type { AdminRole } from "./permissions.js";

type Row = Record<string, unknown>;

/** Only what logActivity actually reads — a full RequestUser satisfies
 * this structurally, but the login handler (which has no request-scoped
 * RequestUser yet, only a freshly-fetched users row) can build one of
 * these directly instead of faking the rest of that type's fields. */
type ActivityActor = { sub: string; name: string; adminRole: AdminRole | null };

export type LogActivityInput = {
  actor: ActivityActor;
  action: string;
  summary: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  /** Only set true for actions with a registered entry in REVERT_HANDLERS
   * below — a revertible flag with nothing to actually revert would just
   * show a "Revert" button that fails. */
  revertible?: boolean;
  ip?: string | null;
};

export async function logActivity(input: LogActivityInput): Promise<void> {
  await db.execute({
    sql: `INSERT INTO admin_activity_log
            (id, actor_id, actor_name, actor_role, action, entity_type, entity_id, summary, before_json, after_json, revertible, ip)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId("act"),
      input.actor.sub,
      input.actor.name,
      input.actor.adminRole,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      input.summary,
      input.before !== undefined ? JSON.stringify(input.before) : null,
      input.after !== undefined ? JSON.stringify(input.after) : null,
      input.revertible ? 1 : 0,
      input.ip ?? null,
    ],
  });
}

/** One handler per revertible `action` value — applies a previously-logged
 * `before` snapshot back onto the live row. Deliberately keyed by the
 * specific action rather than a generic "restore this JSON onto that
 * table", so a handler only ever writes the exact columns that specific
 * action is known to have changed. */
const REVERT_HANDLERS: Record<string, (entityId: string, before: Row) => Promise<void>> = {
  "user.status": async (entityId, before) => {
    await db.execute({
      sql: "UPDATE users SET status = ?, updated_at = datetime('now') WHERE id = ?",
      args: [before.status as string, entityId],
    });
  },
  "rider.verify": async (entityId, before) => {
    await db.execute({
      sql: "UPDATE riders SET verified = ?, updated_at = datetime('now') WHERE user_id = ?",
      args: [before.verified as number, entityId],
    });
  },
  "settings.update": async (_entityId, before) => {
    if (before.deliveryRatePerKm != null) await setSetting("delivery_rate_per_km", String(before.deliveryRatePerKm));
    if (before.serviceRangeKm != null) await setSetting("service_range_km", String(before.serviceRangeKm));
    if (before.enabledModes != null) await setMatchingModesEnabled(before.enabledModes as never);
    if (before.nearestWindowSeconds != null) await setSetting("nearest_window_seconds", String(before.nearestWindowSeconds));
    if (before.maxAssignmentMinutes != null) await setSetting("max_assignment_minutes", String(before.maxAssignmentMinutes));
  },
  "staff.role_change": async (entityId, before) => {
    await db.execute({
      sql: "UPDATE users SET admin_role = ?, updated_at = datetime('now') WHERE id = ?",
      args: [before.adminRole as string, entityId],
    });
  },
  "staff.status": async (entityId, before) => {
    await db.execute({
      sql: `UPDATE users SET status = ?,
                   sessions_valid_from = CASE WHEN ? = 'suspended' THEN datetime('now') ELSE sessions_valid_from END,
                   updated_at = datetime('now')
            WHERE id = ?`,
      args: [before.status as string, before.status as string, entityId],
    });
  },
};

export type RevertResult =
  | { ok: true }
  | { ok: false; error: "not_found" | "not_revertible" | "already_reverted" | "no_handler" };

/**
 * Reverts one logged action and records the revert as its own new entry —
 * the original row is never edited or deleted, so the log stays a
 * complete history rather than one that quietly rewrites itself.
 */
export async function revertActivity(logId: string, actor: ActivityActor): Promise<RevertResult> {
  const res = await db.execute({ sql: "SELECT * FROM admin_activity_log WHERE id = ?", args: [logId] });
  const entry = res.rows[0] as Row | undefined;
  if (!entry) return { ok: false, error: "not_found" };
  if (!entry.revertible) return { ok: false, error: "not_revertible" };
  if (entry.reverted_at) return { ok: false, error: "already_reverted" };

  const handler = REVERT_HANDLERS[entry.action as string];
  if (!handler) return { ok: false, error: "no_handler" };
  if (!entry.entity_id && entry.action !== "settings.update") return { ok: false, error: "no_handler" };
  if (!entry.before_json) return { ok: false, error: "no_handler" };

  const before = JSON.parse(entry.before_json as string) as Row;
  await handler((entry.entity_id as string) ?? "", before);

  await db.execute({
    sql: "UPDATE admin_activity_log SET reverted_at = datetime('now'), reverted_by = ? WHERE id = ?",
    args: [actor.sub, logId],
  });

  await logActivity({
    actor,
    action: "activity.revert",
    entityType: entry.entity_type as string | undefined,
    entityId: entry.entity_id as string | undefined,
    summary: `Reverted: ${entry.summary as string}`,
  });

  return { ok: true };
}
