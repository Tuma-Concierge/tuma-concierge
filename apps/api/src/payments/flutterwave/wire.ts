/**
 * Flutterwave API client — Standard Checkout (a Flutterwave-hosted payment
 * page) rather than their raw per-method "Direct Charge" endpoints. Two
 * reasons: it's the one integration that covers both mobile money and
 * cards at once instead of two separate flows to build and maintain, and
 * it means a card number never touches Tuma's own server — the customer
 * enters it on Flutterwave's page, which is what keeps this integration
 * out of full PCI-DSS card-data-handling scope (SAQ-A eligible) instead of
 * the much heavier bar direct card charges would require.
 *
 * Only used when PAYMENTS provider selection (see ../service.ts) resolves
 * to "flutterwave" and a secret key resolves (admin-entered via
 * ../credentials.ts, or the FLUTTERWAVE_SECRET_KEY env var as a fallback) —
 * otherwise ./mock.ts stands in, with the same request/response contract.
 *
 * API reference: https://developer.flutterwave.com/docs (v3)
 */

import { getCredential, isProviderConfigured } from "../credentials.js";
import type { GatewayChargeInput, GatewayResult, PaymentGatewayAdapter } from "../gateway.js";

const API_BASE = "https://api.flutterwave.com/v3";

async function secretKey(): Promise<string> {
  const key = await getCredential("flutterwave", "secretKey");
  if (!key) throw new Error("Flutterwave secret key is not set");
  return key;
}

export function isFlutterwaveConfigured(): Promise<boolean> {
  return isProviderConfigured("flutterwave");
}

/** A phone-first signup may have no email on file, but Standard Checkout
 * requires one — Flutterwave never actually sends mail to it, the field is
 * just an account identifier on their side. */
function customerEmail(input: GatewayChargeInput): string {
  return input.email?.trim() || `${input.referenceId}@customers.tumaffe.online`;
}

type CreatePaymentResponse = {
  status: string;
  message?: string;
  data?: { link?: string };
};

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${await secretKey()}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) {
    throw new Error(`Flutterwave request failed: ${res.status} ${body.message ?? JSON.stringify(body)}`);
  }
  return body;
}

/** Creates a hosted payment link covering both mobile money and cards —
 * the customer picks their method on Flutterwave's own page. There is no
 * separate deposit vs withdraw shape here (Flutterwave has no disbursement
 * support in this adapter — see supportsDisbursement below), so this is
 * the only "charge" entry point. */
async function createPaymentLink(input: GatewayChargeInput): Promise<GatewayResult> {
  const body = await call<CreatePaymentResponse>("/payments", {
    method: "POST",
    body: JSON.stringify({
      tx_ref: input.referenceId,
      amount: input.amount,
      currency: input.currency,
      redirect_url: input.returnUrl,
      customer: {
        email: customerEmail(input),
        phone_number: input.msisdn,
        name: input.name,
      },
      customizations: { title: "Tuma" },
      payment_options: "card,mobilemoneyuganda",
      meta: { narrative: input.narrative },
    }),
  });
  if (body.status !== "success" || !body.data?.link) {
    throw new Error(`Flutterwave did not return a payment link: ${body.message ?? "unknown error"}`);
  }
  return { status: "PENDING", transactionReference: input.referenceId, redirectUrl: body.data.link };
}

type VerifyResponse = {
  status: string;
  data?: { status?: string; amount?: number; currency?: string; id?: number };
};

function mapStatus(raw: string | undefined): GatewayResult["status"] {
  switch ((raw ?? "").toLowerCase()) {
    case "successful":
      return "SUCCEEDED";
    case "failed":
      return "FAILED";
    default:
      return "PENDING";
  }
}

export async function checkStatus(transactionReference: string): Promise<GatewayResult> {
  const body = await call<VerifyResponse>(
    `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(transactionReference)}`,
    { method: "GET" },
  );
  return {
    status: body.status === "success" ? mapStatus(body.data?.status) : "PENDING",
    transactionReference,
    providerTransactionId: body.data?.id != null ? String(body.data.id) : undefined,
  };
}

/** Flutterwave signs webhooks with a plain shared secret in the `verif-hash`
 * header (not an HMAC of the body) — this is their documented scheme, not
 * a shortcut taken here. Constant-time comparison, same pattern as the Yo!
 * callback's own token check in ../routes.ts. */
export async function verifyWebhookSignature(providedHeader: string | null | undefined): Promise<boolean> {
  const expected = await getCredential("flutterwave", "webhookSecret");
  if (!expected) return false;
  const provided = providedHeader ?? "";
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i += 1) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const flutterwaveAdapter: PaymentGatewayAdapter = {
  key: "flutterwave",
  displayName: "Flutterwave",
  isConfigured: isFlutterwaveConfigured,
  // Payouts use a different Flutterwave API (Transfers) with per-network
  // bank codes this adapter doesn't implement yet — rider withdrawals stay
  // on Yo! regardless of which provider is active for collections. See
  // ../service.ts resolveProvider().
  supportsDisbursement: false,
  // Standard Checkout lets the customer pick MTN/Airtel/card on
  // Flutterwave's own page — Tuma never needs to resolve a network first.
  requiresNetwork: false,
  depositFunds: createPaymentLink,
  async withdrawFunds(): Promise<GatewayResult> {
    throw new Error("Flutterwave disbursement is not implemented — resolveProvider() should never route here");
  },
  checkStatus,
};
