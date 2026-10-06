import type { MatchingMode } from "@tuma/shared";
import { db } from "../db/client.js";

const DEFAULTS = {
  /** Which dataset the whole platform — every customer, rider, and the
   * admin dashboard's default view — currently reads and writes against.
   * "live" is real orders/money; "sandbox" is demo/test data, fully
   * isolated (separate orders, lists, wallet balances, ledger entries —
   * see migrations/0030_sandbox_live_state.sql) and never able to reach a
   * real payment rail regardless of what credentials are configured (see
   * ../payments/service.ts resolveProvider's forceMock). Toggling this
   * doesn't delete or move anything — it just changes which environment's
   * rows every read/write path in the app targets. */
  platform_environment: "live",
  payments_enabled_methods: '["cash"]',
  payout_check_seconds: "120",
  delivery_rate_per_km: "1000",
  service_range_km: "7",
  /** Flat delivery fee (UGX) charged on top of a shopping order's item
   * costs. Unlike a parcel ride there's no pickup point to measure a
   * distance from at order-creation time (the "pickup" is wherever the
   * rider ends up shopping, unknown until one claims the job) — so this
   * is a flat admin-set amount rather than distance × rate. */
  shopping_delivery_fee: "3000",
  /** Ceiling on what a single order may charge into escrow (UGX). Guards
   * against a fat-fingered or forged estimate turning into a payment
   * request nobody meant to make. */
  max_order_value: "5000000",
  /** Which rider-matching modes are on offer platform-wide — see
   * ../orders/matching.ts. JSON array of MatchingMode values. A customer's
   * own preference only takes effect if it's in this set; the default
   * keeps today's behavior (first rider to claim wins) until an admin
   * turns anything else on. */
  matching_modes_enabled: '["first_to_claim"]',
  /** How long an order in "nearest_window" mode waits to collect applicants
   * before the app auto-assigns whichever is nearest. */
  nearest_window_seconds: "90",
  /** Safety-net ceiling (for nearest_window and customer_selects) — if
   * nobody's been assigned by this long after the order was created, the
   * app auto-assigns rather than leaving the customer waiting indefinitely. */
  max_assignment_minutes: "5",
  /** Which payment aggregators are on offer, in priority order — the first
   * entry is primary, a second entry is the fallback used once the primary
   * has no working credentials. JSON array of "yo" | "flutterwave". See
   * ../payments/service.ts resolveProvider(). */
  payments_active_providers: '["yo"]',
  /** Force every payment through the mock/simulated adapters, even when a
   * real provider has working credentials saved. Lets an admin test live
   * credentials without switching them live, or pull the whole platform
   * back to demo transactions instantly (no need to delete/blank the
   * credentials themselves) if something looks wrong with a real
   * aggregator. "1" = demo mode on, anything else = off. See
   * ../payments/service.ts resolveProvider(). */
  payments_demo_mode: "0",
  /** Wallet balance ceilings (UGX), tiered by verification the same way
   * mobile money itself limits unverified accounts — see
   * ../wallet/routes.ts. */
  wallet_unverified_cap: "200000",
  wallet_verified_cap: "2000000",
  /** Ceiling on a single top-up request, independent of the balance cap —
   * stops one oversized top-up from being the only thing that matters. */
  wallet_max_topup: "1000000",
  /** How long any voice recording (a shopping list, an order note, a fee-
   * proposal reason, a chat voice message) may run before it auto-stops.
   * Nobody's meant to be recording minutes of audio here — this is a cap,
   * not a target. */
  voice_note_max_seconds: "60",
} as const;

export type SettingKey = keyof typeof DEFAULTS;

export type PaymentMethod = "cash" | "mobile_money";
export async function setPaymentMethods(methods: PaymentMethod[]): Promise<void> {
  if (!methods.length || methods.some((method) => method !== "cash" && method !== "mobile_money")) {
    throw new Error("Keep at least one valid payment method active");
  }
  await setSetting("payments_enabled_methods", JSON.stringify([...new Set(methods)]));
}
export async function getPaymentMethods(): Promise<PaymentMethod[]> {
  try {
    const value: unknown = JSON.parse(await getSetting("payments_enabled_methods"));
    const methods = Array.isArray(value) ? [...new Set(value.filter((m): m is PaymentMethod => m === "cash" || m === "mobile_money"))] : [];
    return methods.length ? methods : ["cash"];
  } catch { return ["cash"]; }
}

export async function getSetting(key: SettingKey): Promise<string> {
  const res = await db.execute({ sql: "SELECT value FROM settings WHERE key = ?", args: [key] });
  return (res.rows[0]?.value as string | undefined) ?? DEFAULTS[key];
}

export async function setSetting(key: SettingKey, value: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, value],
  });
}

export type PlatformEnvironment = "live" | "sandbox";

export async function getPlatformEnvironment(): Promise<PlatformEnvironment> {
  return (await getSetting("platform_environment")) === "sandbox" ? "sandbox" : "live";
}

export async function setPlatformEnvironment(env: PlatformEnvironment): Promise<void> {
  await setSetting("platform_environment", env);
}

export async function getDeliverySettings(): Promise<{
  deliveryRatePerKm: number;
  serviceRangeKm: number;
  shoppingDeliveryFee: number;
}> {
  const [rate, range, shoppingFee] = await Promise.all([
    getSetting("delivery_rate_per_km"),
    getSetting("service_range_km"),
    getSetting("shopping_delivery_fee"),
  ]);
  return {
    deliveryRatePerKm: Number(rate) || Number(DEFAULTS.delivery_rate_per_km),
    serviceRangeKm: Number(range) || Number(DEFAULTS.service_range_km),
    shoppingDeliveryFee: Number(shoppingFee) || Number(DEFAULTS.shopping_delivery_fee),
  };
}

export async function getMaxOrderValue(): Promise<number> {
  return Number(await getSetting("max_order_value")) || Number(DEFAULTS.max_order_value);
}

const ALL_MATCHING_MODES: MatchingMode[] = ["first_to_claim", "nearest_window", "customer_selects"];

function parseEnabledModes(raw: string): MatchingMode[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const modes = Array.isArray(parsed) ? parsed.filter((m): m is MatchingMode => ALL_MATCHING_MODES.includes(m as MatchingMode)) : [];
    return modes.length > 0 ? modes : ["first_to_claim"];
  } catch {
    return ["first_to_claim"];
  }
}

export async function getMatchingSettings(): Promise<{
  enabledModes: MatchingMode[];
  nearestWindowSeconds: number;
  maxAssignmentMinutes: number;
}> {
  const [modesRaw, windowRaw, maxRaw] = await Promise.all([
    getSetting("matching_modes_enabled"),
    getSetting("nearest_window_seconds"),
    getSetting("max_assignment_minutes"),
  ]);
  return {
    enabledModes: parseEnabledModes(modesRaw),
    nearestWindowSeconds: Number(windowRaw) || Number(DEFAULTS.nearest_window_seconds),
    maxAssignmentMinutes: Number(maxRaw) || Number(DEFAULTS.max_assignment_minutes),
  };
}

export async function setMatchingModesEnabled(modes: MatchingMode[]): Promise<void> {
  const valid = modes.filter((m) => ALL_MATCHING_MODES.includes(m));
  await setSetting("matching_modes_enabled", JSON.stringify(valid.length > 0 ? valid : ["first_to_claim"]));
}

export type PaymentProviderIdentity = "yo" | "flutterwave";
const ALL_PROVIDER_IDENTITIES: PaymentProviderIdentity[] = ["yo", "flutterwave"];

/** Priority-ordered list of admin-enabled providers — first is primary, a
 * second is the fallback. Falls back to just "yo" (today's only provider)
 * if the stored value is missing/corrupt/empty. */
export async function getActiveProviders(): Promise<PaymentProviderIdentity[]> {
  const raw = await getSetting("payments_active_providers");
  try {
    const parsed = JSON.parse(raw) as unknown;
    const providers = Array.isArray(parsed)
      ? parsed.filter((p): p is PaymentProviderIdentity => ALL_PROVIDER_IDENTITIES.includes(p as PaymentProviderIdentity))
      : [];
    return providers.length > 0 ? providers : ["yo"];
  } catch {
    return ["yo"];
  }
}

export async function setActiveProviders(providers: PaymentProviderIdentity[]): Promise<void> {
  const valid = providers.filter((p) => ALL_PROVIDER_IDENTITIES.includes(p));
  const deduped = [...new Set(valid)];
  await setSetting("payments_active_providers", JSON.stringify(deduped.length > 0 ? deduped : ["yo"]));
}

export async function getPaymentsDemoMode(): Promise<boolean> {
  return (await getSetting("payments_demo_mode")) === "1";
}

export async function setPaymentsDemoMode(enabled: boolean): Promise<void> {
  await setSetting("payments_demo_mode", enabled ? "1" : "0");
}

export async function getWalletSettings(): Promise<{ unverifiedCap: number; verifiedCap: number; maxTopup: number }> {
  const [unverified, verified, maxTopup] = await Promise.all([
    getSetting("wallet_unverified_cap"),
    getSetting("wallet_verified_cap"),
    getSetting("wallet_max_topup"),
  ]);
  return {
    unverifiedCap: Number(unverified) || Number(DEFAULTS.wallet_unverified_cap),
    verifiedCap: Number(verified) || Number(DEFAULTS.wallet_verified_cap),
    maxTopup: Number(maxTopup) || Number(DEFAULTS.wallet_max_topup),
  };
}

export async function getVoiceNoteMaxSeconds(): Promise<number> {
  return Number(await getSetting("voice_note_max_seconds")) || Number(DEFAULTS.voice_note_max_seconds);
}
