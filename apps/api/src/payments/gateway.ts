/**
 * The one contract every payment aggregator adapter implements (Yo!
 * Payments, Flutterwave, and each one's mock). Before this file existed,
 * ../service.ts dispatched provider calls with an inline `=== "yo" ? ... :
 * ...` ternary at each call site — fine for one real provider, not for two.
 * Everything downstream (orders/routes.ts, riders/routes.ts, wallet
 * routes) talks to ../service.ts only; adapters never leak upward.
 */

import type { MobileMoneyNetwork } from "@tuma/shared";

export type GatewayStatus = "PENDING" | "SUCCEEDED" | "FAILED" | "INDETERMINATE";

export type GatewayChargeInput = {
  referenceId: string;
  amount: number;
  currency: string;
  msisdn?: string;
  network?: MobileMoneyNetwork;
  email?: string;
  name?: string;
  narrative: string;
  /** Where a hosted-checkout provider (Flutterwave) should return the
   * customer after they pay. Ignored by a direct-push provider (Yo!),
   * which never leaves the app. */
  returnUrl?: string;
};

export type GatewayResult = {
  status: GatewayStatus;
  transactionReference: string;
  /** Present only for hosted-checkout providers — the caller must send the
   * customer's browser here to actually complete payment. A direct-push
   * provider confirms without ever handing back a URL. */
  redirectUrl?: string;
  providerTransactionId?: string;
  statusMessage?: string;
};

export interface PaymentGatewayAdapter {
  key: string;
  displayName: string;
  /** True once this adapter's own API credentials are present (DB-stored,
   * admin-entered — see ./credentials.ts — or an env var fallback), checked
   * live every call, never cached, so an admin saving new keys takes effect
   * on the next request with no redeploy. */
  isConfigured(): Promise<boolean>;
  /** Whether this adapter can pay money OUT (rider payouts). Collection-only
   * providers (Flutterwave, for now) report false here rather than fail at
   * call time — see resolveProvider() in ./service.ts. */
  supportsDisbursement: boolean;
  /** Whether this adapter needs a resolved MTN/Airtel network before it can
   * charge — true for a direct-push provider (Yo!), false for a hosted
   * checkout (Flutterwave) that lets the customer pick their method on its
   * own page. */
  requiresNetwork: boolean;
  depositFunds(input: GatewayChargeInput): Promise<GatewayResult>;
  withdrawFunds(input: GatewayChargeInput): Promise<GatewayResult>;
  /** `createdAt` (SQLite `datetime('now')` format) is only meaningful to a
   * mock adapter, which derives a fake PENDING→SUCCEEDED/FAILED progression
   * from elapsed time instead of asking a real API that tracks its own. A
   * real adapter ignores it. */
  checkStatus(transactionReference: string, createdAt: string): Promise<GatewayResult>;
}
