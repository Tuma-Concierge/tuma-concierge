import { Hono } from "hono";
import { z } from "zod";
import { logActivity } from "../admin/activity.js";
import { hasPermission, requirePermission } from "../admin/permissions.js";
import { requireAuth, requireRole } from "../auth/middleware.js";
import { clientIp } from "../lib/ratelimit.js";
import {
  getActiveProviders,
  getDeliverySettings,
  getMatchingSettings,
  getPaymentsDemoMode,
  getPlatformEnvironment,
  getVoiceNoteMaxSeconds,
  getWalletSettings,
  setActiveProviders,
  setMatchingModesEnabled,
  setPaymentsDemoMode,
  setPlatformEnvironment,
  setSetting,
  type PaymentProviderIdentity,
} from "../lib/settings.js";
import { clearCredential, PROVIDER_CREDENTIAL_FIELDS, saveCredentials } from "../payments/credentials.js";
import { paymentsIntegrationStatus } from "../payments/service.js";

export const settingsRoutes = new Hono();

async function fullSettings() {
  const [delivery, matching, activeProviders, demoMode, wallet, voiceNoteMaxSeconds, platformEnvironment] =
    await Promise.all([
      getDeliverySettings(),
      getMatchingSettings(),
      getActiveProviders(),
      getPaymentsDemoMode(),
      getWalletSettings(),
      getVoiceNoteMaxSeconds(),
      getPlatformEnvironment(),
    ]);
  return {
    ...delivery,
    ...matching,
    paymentsActiveProviders: activeProviders,
    paymentsDemoMode: demoMode,
    walletUnverifiedCap: wallet.unverifiedCap,
    walletVerifiedCap: wallet.verifiedCap,
    walletMaxTopup: wallet.maxTopup,
    voiceNoteMaxSeconds,
    platformEnvironment,
  };
}

/** Any signed-in user: the customer app needs the current rate/range (to show
 * a live estimate) and which matching modes are on offer (to build the
 * preference picker). None of it is sensitive, but it isn't reachable while
 * signed out either — orderRoutes registers requireAuth as "*" on the shared
 * /v1 router, which covers everything mounted after it, this included. */
settingsRoutes.get("/settings", async (c) => {
  return c.json({ settings: await fullSettings() });
});

const updateSchema = z.object({
  deliveryRatePerKm: z.number().positive().max(1_000_000).optional(),
  serviceRangeKm: z.number().positive().max(1000).optional(),
  shoppingDeliveryFee: z.number().int().nonnegative().max(1_000_000).optional(),
  enabledModes: z.array(z.enum(["first_to_claim", "nearest_window", "customer_selects"])).optional(),
  nearestWindowSeconds: z.number().int().positive().max(3600).optional(),
  maxAssignmentMinutes: z.number().int().positive().max(120).optional(),
  paymentsActiveProviders: z.array(z.enum(["yo", "flutterwave"])).min(1).max(2).optional(),
  paymentsDemoMode: z.boolean().optional(),
  walletUnverifiedCap: z.number().int().positive().max(100_000_000).optional(),
  walletVerifiedCap: z.number().int().positive().max(100_000_000).optional(),
  walletMaxTopup: z.number().int().positive().max(100_000_000).optional(),
  voiceNoteMaxSeconds: z.number().int().positive().max(600).optional(),
});

const PAYMENTS_FIELDS = [
  "paymentsActiveProviders",
  "paymentsDemoMode",
  "walletUnverifiedCap",
  "walletVerifiedCap",
  "walletMaxTopup",
] as const;

settingsRoutes.put(
  "/admin/settings",
  requireAuth,
  requireRole("admin"),
  requirePermission("settings.manage"),
  async (c) => {
    const user = c.get("user");
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    // Which payment aggregator moves real money is a bigger blast radius
    // than delivery pricing — require the more specific permission too,
    // rather than letting anyone with generic settings.manage flip it.
    if (PAYMENTS_FIELDS.some((f) => parsed.data[f] != null) && !hasPermission(user.adminRole, "payments.manage")) {
      return c.json({ error: "forbidden", message: "Requires the payments.manage permission" }, 403);
    }

    const before = await fullSettings();

    if (parsed.data.deliveryRatePerKm != null) {
      await setSetting("delivery_rate_per_km", String(parsed.data.deliveryRatePerKm));
    }
    if (parsed.data.serviceRangeKm != null) {
      await setSetting("service_range_km", String(parsed.data.serviceRangeKm));
    }
    if (parsed.data.shoppingDeliveryFee != null) {
      await setSetting("shopping_delivery_fee", String(parsed.data.shoppingDeliveryFee));
    }
    if (parsed.data.enabledModes != null) {
      await setMatchingModesEnabled(parsed.data.enabledModes);
    }
    if (parsed.data.nearestWindowSeconds != null) {
      await setSetting("nearest_window_seconds", String(parsed.data.nearestWindowSeconds));
    }
    if (parsed.data.maxAssignmentMinutes != null) {
      await setSetting("max_assignment_minutes", String(parsed.data.maxAssignmentMinutes));
    }
    if (parsed.data.paymentsActiveProviders != null) {
      await setActiveProviders(parsed.data.paymentsActiveProviders as PaymentProviderIdentity[]);
    }
    if (parsed.data.paymentsDemoMode != null) {
      await setPaymentsDemoMode(parsed.data.paymentsDemoMode);
    }
    if (parsed.data.walletUnverifiedCap != null) {
      await setSetting("wallet_unverified_cap", String(parsed.data.walletUnverifiedCap));
    }
    if (parsed.data.walletVerifiedCap != null) {
      await setSetting("wallet_verified_cap", String(parsed.data.walletVerifiedCap));
    }
    if (parsed.data.walletMaxTopup != null) {
      await setSetting("wallet_max_topup", String(parsed.data.walletMaxTopup));
    }
    if (parsed.data.voiceNoteMaxSeconds != null) {
      await setSetting("voice_note_max_seconds", String(parsed.data.voiceNoteMaxSeconds));
    }

    const after = await fullSettings();

    await logActivity({
      actor: user,
      action: "settings.update",
      entityType: "settings",
      summary: "Updated platform settings",
      before,
      after,
      revertible: true,
      ip: clientIp(c),
    });

    return c.json({ settings: after });
  },
);

const environmentSchema = z.object({ environment: z.enum(["live", "sandbox"]) });

/**
 * The whole-platform live/sandbox switch — kept as its own endpoint rather
 * than folded into PUT /admin/settings above, deliberately: this is the
 * single most consequential toggle in the app (every customer and rider
 * sees a different dataset the instant it flips), so it gets its own
 * explicit action and its own activity log entry rather than riding along
 * with an unrelated settings save. Same permission gate as the payments
 * fields above — it's exactly as financially significant.
 */
settingsRoutes.put(
  "/admin/platform-environment",
  requireAuth,
  requireRole("admin"),
  requirePermission("settings.manage"),
  requirePermission("payments.manage"),
  async (c) => {
    const user = c.get("user");
    const parsed = environmentSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid_body", issues: parsed.error.issues }, 400);

    const before = await getPlatformEnvironment();
    if (before === parsed.data.environment) {
      return c.json({ platformEnvironment: before });
    }

    await setPlatformEnvironment(parsed.data.environment);

    await logActivity({
      actor: user,
      action: "settings.platform_environment",
      entityType: "settings",
      summary: `Switched the platform from ${before} to ${parsed.data.environment}`,
      before: { platformEnvironment: before },
      after: { platformEnvironment: parsed.data.environment },
      ip: clientIp(c),
    });

    return c.json({ platformEnvironment: parsed.data.environment });
  },
);

const providerParam = z.enum(["yo", "flutterwave"]);

const saveCredentialsSchema = z.object({
  fields: z.record(z.string(), z.string().max(2000)),
});

/**
 * Saves API credentials for one payment aggregator. Same gate as the
 * paymentsActiveProviders field above (settings.manage + payments.manage) —
 * this is a strictly more sensitive version of the same action, so it
 * doesn't need its own permission. Values are encrypted before they touch
 * the DB (see ../payments/credentials.ts); the activity log only ever
 * records which field *keys* changed, never their contents.
 */
settingsRoutes.put(
  "/admin/payments/credentials/:provider",
  requireAuth,
  requireRole("admin"),
  requirePermission("settings.manage"),
  requirePermission("payments.manage"),
  async (c) => {
    const user = c.get("user");
    const providerParsed = providerParam.safeParse(c.req.param("provider"));
    if (!providerParsed.success) return c.json({ error: "invalid_provider" }, 400);
    const provider = providerParsed.data as PaymentProviderIdentity;

    const bodyParsed = saveCredentialsSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!bodyParsed.success) return c.json({ error: "invalid_body", issues: bodyParsed.error.issues }, 400);

    const validKeys = new Set(PROVIDER_CREDENTIAL_FIELDS[provider].map((f) => f.key));
    const unknown = Object.keys(bodyParsed.data.fields).filter((k) => !validKeys.has(k));
    if (unknown.length > 0) return c.json({ error: "unknown_field", fields: unknown }, 400);

    const changed = await saveCredentials(provider, bodyParsed.data.fields);

    if (changed.length > 0) {
      await logActivity({
        actor: user,
        action: "payments.credentials.update",
        entityType: "payment_credentials",
        entityId: provider,
        summary: `Updated ${provider} credentials: ${changed.join(", ")}`,
        ip: clientIp(c),
      });
    }

    return c.json({ changed });
  },
);

/** Clears one saved credential field, reverting it to its env-var fallback
 * (if any) — e.g. to roll back to sandbox after testing production keys. */
settingsRoutes.delete(
  "/admin/payments/credentials/:provider/:field",
  requireAuth,
  requireRole("admin"),
  requirePermission("settings.manage"),
  requirePermission("payments.manage"),
  async (c) => {
    const user = c.get("user");
    const providerParsed = providerParam.safeParse(c.req.param("provider"));
    if (!providerParsed.success) return c.json({ error: "invalid_provider" }, 400);
    const provider = providerParsed.data as PaymentProviderIdentity;

    const field = c.req.param("field") ?? "";
    const validKeys = new Set(PROVIDER_CREDENTIAL_FIELDS[provider].map((f) => f.key));
    if (!validKeys.has(field)) return c.json({ error: "unknown_field" }, 400);

    await clearCredential(provider, field);
    await logActivity({
      actor: user,
      action: "payments.credentials.clear",
      entityType: "payment_credentials",
      entityId: provider,
      summary: `Cleared ${provider} credential field: ${field}`,
      ip: clientIp(c),
    });

    return c.json({ ok: true });
  },
);
