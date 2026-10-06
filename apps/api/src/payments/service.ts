/**
 * Payment aggregator orchestration — the one seam every caller (order
 * funding, rider payouts, wallet top-ups) goes through. Which real
 * aggregator actually handles a given call is resolved from the
 * admin-configurable settings.payments_active_providers list (see
 * ../lib/settings.ts), falling back through providers in priority order to
 * whichever one actually has working credentials, and finally to a mock if
 * none do — so this always works in local dev with zero configuration, and
 * an admin can add/switch/remove a live aggregator with no redeploy.
 */

import { detectMobileMoneyNetwork, mobileMoneyNetworkLabel, type MobileMoneyNetwork } from "@tuma/shared";
import { getActiveProviders, getPaymentsDemoMode, type PaymentProviderIdentity } from "../lib/settings.js";
import { credentialFieldStatus } from "./credentials.js";
import type { GatewayResult, PaymentGatewayAdapter } from "./gateway.js";
import { flutterwaveAdapter } from "./flutterwave/wire.js";
import { mockFlutterwaveAdapter } from "./flutterwave/mock.js";
import { yoAdapter } from "./yo/wire.js";
import { mockYoAdapter } from "./yo/mock.js";

/** Every provider identity this app knows how to talk to, real and mock.
 * The DB only ever stores one of these strings in payments.provider /
 * wallet_topups.provider / wallet_withdrawals.provider. */
export type PaymentsProvider = "yo" | "yo_mock" | "flutterwave" | "flutterwave_mock";

const ADAPTERS: Record<PaymentsProvider, PaymentGatewayAdapter> = {
  yo: yoAdapter,
  yo_mock: mockYoAdapter,
  flutterwave: flutterwaveAdapter,
  flutterwave_mock: mockFlutterwaveAdapter,
};

function mockOf(identity: PaymentProviderIdentity): PaymentsProvider {
  return identity === "yo" ? "yo_mock" : "flutterwave_mock";
}

/**
 * Walks the admin's priority-ordered provider list and returns the first
 * one that's both configured (real credentials present) and able to do
 * what's being asked (a collection-only provider is skipped for a
 * disbursement). Falls back to the first list entry's mock — never to an
 * unconfigured real adapter — so a misconfigured "flutterwave" selection
 * degrades to a working simulation instead of failing every payment.
 *
 * Demo mode (settings.payments_demo_mode) short-circuits all of that: every
 * payment runs through the mock adapters regardless of what credentials are
 * saved, so an admin can test/demo the app — or pull it back from a shaky
 * live aggregator — without touching the credentials themselves.
 *
 * `forceMock` does the same short-circuit for a single call, independent of
 * the demo-mode setting — this is what a sandbox-environment order/top-up
 * passes (see ../lib/settings.ts's platform_environment and every call site
 * that threads an order's/topup's own environment through here) so sandbox
 * activity can *never* reach a real payment rail, even if an admin flips
 * demo mode off and live credentials are sitting there configured.
 */
export async function resolveProvider(
  capability: "collection" | "disbursement",
  options?: { forceMock?: boolean },
): Promise<PaymentsProvider> {
  const active = await getActiveProviders();
  const demoMode = (await getPaymentsDemoMode()) || !!options?.forceMock;
  if (!demoMode) {
    for (const identity of active) {
      const adapter = ADAPTERS[identity];
      if (!(await adapter.isConfigured())) continue;
      if (capability === "disbursement" && !adapter.supportsDisbursement) continue;
      return identity;
    }
  }
  // Nothing configured (or configured-but-incapable), or demo mode is on —
  // mock the first choice that *would* support this capability, so
  // disbursement still simulates through Yo!'s mock even if Flutterwave is
  // primary.
  const fallbackIdentity = active.find((p) => capability !== "disbursement" || ADAPTERS[p].supportsDisbursement) ?? "yo";
  return mockOf(fallbackIdentity);
}

export async function paymentsIntegrationStatus() {
  const active = await getActiveProviders();
  const demoMode = await getPaymentsDemoMode();
  const collectionProvider = await resolveProvider("collection");
  const disbursementProvider = await resolveProvider("disbursement");
  const providers = await Promise.all(
    (["yo", "flutterwave"] as PaymentProviderIdentity[]).map(async (identity) => ({
      key: identity,
      displayName: ADAPTERS[identity].displayName,
      configured: await ADAPTERS[identity].isConfigured(),
      supportsDisbursement: ADAPTERS[identity].supportsDisbursement,
      active: active.includes(identity),
      priority: active.indexOf(identity),
      credentialFields: await credentialFieldStatus(identity),
    })),
  );
  return {
    activeProviders: active,
    demoMode,
    providers,
    collection: { provider: collectionProvider, live: !demoMode && !collectionProvider.endsWith("_mock") },
    disbursement: { provider: disbursementProvider, live: !demoMode && !disbursementProvider.endsWith("_mock") },
    networks: ["mtn_momo", "airtel_money"],
  };
}

export class UnsupportedNetworkError extends Error {}

function resolveNetwork(msisdn: string): MobileMoneyNetwork {
  const network = detectMobileMoneyNetwork(msisdn);
  if (!network) {
    throw new UnsupportedNetworkError(`${msisdn} isn't a recognized MTN or Airtel Uganda number`);
  }
  return network;
}

type InitiateInput = {
  referenceId: string;
  msisdn?: string;
  amount: number;
  currency?: string;
  email?: string;
  name?: string;
  narrative?: string;
  /** Where a hosted-checkout provider should return the customer once
   * they've paid — required if Flutterwave might end up handling this. */
  returnUrl?: string;
  /** Set true for anything happening under the sandbox platform
   * environment — forces resolveProvider() to mock regardless of demo
   * mode or configured credentials. See resolveProvider's doc comment. */
  forceMock?: boolean;
};

type InitiateResult = {
  provider: PaymentsProvider;
  providerRef: string;
  network: MobileMoneyNetwork | null;
  /** Set only when the resolved provider is a hosted-checkout style one —
   * the caller must send the customer's browser here before this payment
   * can complete. Absent for a direct-push provider (Yo!). */
  redirectUrl?: string;
};

async function initiate(
  capability: "collection" | "disbursement",
  input: InitiateInput,
  defaultNarrative: string,
): Promise<InitiateResult> {
  const provider = await resolveProvider(capability, { forceMock: input.forceMock });
  const adapter = ADAPTERS[provider];

  let network: MobileMoneyNetwork | null = null;
  if (adapter.requiresNetwork) {
    network = resolveNetwork(input.msisdn ?? "");
  } else if (input.msisdn) {
    network = detectMobileMoneyNetwork(input.msisdn);
  }

  const fn = capability === "collection" ? adapter.depositFunds : adapter.withdrawFunds;
  const result: GatewayResult = await fn({
    referenceId: input.referenceId,
    amount: input.amount,
    currency: input.currency ?? "UGX",
    msisdn: input.msisdn,
    network: network ?? undefined,
    email: input.email,
    name: input.name,
    narrative: input.narrative ?? defaultNarrative,
    returnUrl: input.returnUrl,
  });

  return { provider, providerRef: result.transactionReference, network, redirectUrl: result.redirectUrl };
}

/** Collections: pulls funds from the customer into escrow (or a wallet top-up). */
export async function initiateCollection(input: InitiateInput): Promise<InitiateResult> {
  return initiate("collection", input, "Tuma order escrow funding");
}

/** Disbursements: pays a rider out of escrow (or their wallet) at withdrawal time. */
export async function initiateDisbursement(input: InitiateInput): Promise<InitiateResult> {
  return initiate("disbursement", input, "Tuma rider payout");
}

export type DbPaymentStatus = "pending" | "successful" | "failed";

function toDbStatus(status: GatewayResult["status"]): DbPaymentStatus {
  if (status === "SUCCEEDED") return "successful";
  if (status === "FAILED") return "failed";
  return "pending";
}

export async function checkPaymentStatus(payment: {
  provider: string;
  provider_ref: string | null;
  created_at: string;
}): Promise<DbPaymentStatus> {
  if (!payment.provider_ref) return "pending";
  const adapter = ADAPTERS[payment.provider as PaymentsProvider];
  if (!adapter) return "pending";
  const result = await adapter.checkStatus(payment.provider_ref, payment.created_at);
  return toDbStatus(result.status);
}

export { mobileMoneyNetworkLabel };
