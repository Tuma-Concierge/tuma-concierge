/**
 * MTN MoMo Open API client — Collections (customer -> escrow) and
 * Disbursements (escrow -> rider). Talks to the real MoMo API surface
 * (sandbox by default via MOMO_TARGET_ENV=sandbox). Going live against
 * MOMO_TARGET_ENV=production requires MTN merchant approval and real
 * subscription/API-user credentials supplied via env — this code never
 * fabricates those and never runs outside the env it's given.
 *
 * Docs: https://momodeveloper.mtn.com/
 */

type Product = "collection" | "disbursement";

export type RequestToPayInput = {
  referenceId: string;
  amount: number;
  currency: string;
  msisdn: string;
  externalId: string;
  payerMessage?: string;
  payeeNote?: string;
};

export type TransferInput = {
  referenceId: string;
  amount: number;
  currency: string;
  msisdn: string;
  externalId: string;
  payerMessage?: string;
  payeeNote?: string;
};

export type MomoStatus = "PENDING" | "SUCCESSFUL" | "FAILED";

function baseUrl(): string {
  return process.env.MOMO_BASE_URL ?? "https://sandbox.momodeveloper.mtn.com";
}

function targetEnv(): string {
  return process.env.MOMO_TARGET_ENV ?? "sandbox";
}

function subscriptionKey(product: Product): string {
  const key =
    product === "collection"
      ? process.env.MOMO_COLLECTION_SUBSCRIPTION_KEY ?? process.env.MOMO_SUBSCRIPTION_KEY
      : process.env.MOMO_DISBURSEMENT_SUBSCRIPTION_KEY ?? process.env.MOMO_SUBSCRIPTION_KEY;
  if (!key) {
    throw new Error(`MOMO_${product.toUpperCase()}_SUBSCRIPTION_KEY (or MOMO_SUBSCRIPTION_KEY) is not set`);
  }
  return key;
}

function apiUser(): string {
  const user = process.env.MOMO_API_USER;
  if (!user) throw new Error("MOMO_API_USER is not set");
  return user;
}

function apiKey(): string {
  const key = process.env.MOMO_API_KEY;
  if (!key) throw new Error("MOMO_API_KEY is not set");
  return key;
}

export function isMomoConfigured(): boolean {
  try {
    apiUser();
    apiKey();
    subscriptionKey("collection");
    return true;
  } catch {
    return false;
  }
}

async function getAccessToken(product: Product): Promise<string> {
  const credentials = btoa(`${apiUser()}:${apiKey()}`);
  const res = await fetch(`${baseUrl()}/${product}/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Ocp-Apim-Subscription-Key": subscriptionKey(product),
    },
  });
  if (!res.ok) {
    throw new Error(`MoMo ${product} token request failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

/** Collections: RequestToPay — pulls funds from the customer's MoMo wallet into escrow. */
export async function requestToPay(input: RequestToPayInput): Promise<void> {
  const token = await getAccessToken("collection");
  const res = await fetch(`${baseUrl()}/collection/v1_0/requesttopay`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Reference-Id": input.referenceId,
      "X-Target-Environment": targetEnv(),
      "Ocp-Apim-Subscription-Key": subscriptionKey("collection"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(input.amount),
      currency: input.currency,
      externalId: input.externalId,
      payer: { partyIdType: "MSISDN", partyId: input.msisdn },
      payerMessage: input.payerMessage ?? "Tuma order escrow funding",
      payeeNote: input.payeeNote ?? "Tuma escrow",
    }),
  });
  if (res.status !== 202) {
    throw new Error(`MoMo requestToPay failed: ${res.status} ${await res.text()}`);
  }
}

export async function getRequestToPayStatus(referenceId: string): Promise<MomoStatus> {
  const token = await getAccessToken("collection");
  const res = await fetch(`${baseUrl()}/collection/v1_0/requesttopay/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Target-Environment": targetEnv(),
      "Ocp-Apim-Subscription-Key": subscriptionKey("collection"),
    },
  });
  if (!res.ok) {
    throw new Error(`MoMo requestToPay status failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { status: MomoStatus };
  return data.status;
}

/** Disbursements: Transfer — pays the rider out of escrow at Settle. */
export async function transfer(input: TransferInput): Promise<void> {
  const token = await getAccessToken("disbursement");
  const res = await fetch(`${baseUrl()}/disbursement/v1_0/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Reference-Id": input.referenceId,
      "X-Target-Environment": targetEnv(),
      "Ocp-Apim-Subscription-Key": subscriptionKey("disbursement"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(input.amount),
      currency: input.currency,
      externalId: input.externalId,
      payee: { partyIdType: "MSISDN", partyId: input.msisdn },
      payerMessage: input.payerMessage ?? "Tuma rider payout",
      payeeNote: input.payeeNote ?? "Tuma settlement",
    }),
  });
  if (res.status !== 202) {
    throw new Error(`MoMo transfer failed: ${res.status} ${await res.text()}`);
  }
}

export async function getTransferStatus(referenceId: string): Promise<MomoStatus> {
  const token = await getAccessToken("disbursement");
  const res = await fetch(`${baseUrl()}/disbursement/v1_0/transfer/${referenceId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Target-Environment": targetEnv(),
      "Ocp-Apim-Subscription-Key": subscriptionKey("disbursement"),
    },
  });
  if (!res.ok) {
    throw new Error(`MoMo transfer status failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { status: MomoStatus };
  return data.status;
}
