/**
 * Admin-editable API credentials for the payment aggregators, stored
 * encrypted in the payment_credentials table (see
 * ../db/migrations/0028_payment_credentials.sql and ../lib/crypto.ts).
 *
 * Every field also has an env-var fallback (YO_API_USERNAME, etc.) so
 * nothing here breaks an existing deployment that only ever set env vars —
 * a DB-stored value just takes priority once an admin saves one. This is
 * read on every request (no in-memory cache) because the app runs on
 * Cloudflare Workers: a module-level cache would go stale across isolates
 * with no way to invalidate it, whereas D1 is already a fast per-request
 * read the rest of this codebase relies on (see ../lib/settings.ts).
 */

import { db } from "../db/client.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import type { PaymentProviderIdentity } from "../lib/settings.js";

export type CredentialFieldDef = {
  key: string;
  label: string;
  /** Masked in the UI and never echoed back once set. */
  secret: boolean;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  /** Env var this field falls back to when nothing's stored in the DB. */
  envVar: string;
};

/** What each aggregator's real API actually needs — see wire.ts in each
 * provider's own folder for how these get used. */
export const PROVIDER_CREDENTIAL_FIELDS: Record<PaymentProviderIdentity, CredentialFieldDef[]> = {
  yo: [
    {
      key: "apiUsername",
      label: "API username",
      secret: false,
      required: true,
      envVar: "YO_API_USERNAME",
      helpText: "From your Yo! Payments merchant dashboard.",
    },
    {
      key: "apiPassword",
      label: "API password",
      secret: true,
      required: true,
      envVar: "YO_API_PASSWORD",
    },
    {
      key: "targetEnv",
      label: "Environment",
      secret: false,
      required: false,
      placeholder: "sandbox",
      envVar: "YO_TARGET_ENV",
      helpText: '"sandbox" or "production" — defaults to sandbox if left blank.',
    },
    {
      key: "callbackSecret",
      label: "Callback secret",
      secret: true,
      required: false,
      envVar: "YO_CALLBACK_SECRET",
      helpText: "Shared secret Yo! includes on payment callbacks, used to verify they're genuine.",
    },
  ],
  flutterwave: [
    {
      key: "secretKey",
      label: "Secret key",
      secret: true,
      required: true,
      envVar: "FLUTTERWAVE_SECRET_KEY",
      helpText: "From Settings → API in your Flutterwave dashboard.",
    },
    {
      key: "webhookSecret",
      label: "Webhook secret hash",
      secret: true,
      required: false,
      envVar: "FLUTTERWAVE_WEBHOOK_SECRET",
      helpText: "The secret hash you set under Settings → Webhooks — used to verify incoming webhooks.",
    },
  ],
};

type Row = { provider: string; field: string; value: string };

/** One encrypted value, read straight from the DB every call — see the
 * module doc for why this isn't cached. */
async function readStored(provider: PaymentProviderIdentity, field: string): Promise<string | undefined> {
  let res;
  try {
    res = await db.execute({
      sql: "SELECT value FROM payment_credentials WHERE provider = ? AND field = ?",
      args: [provider, field],
    });
  } catch (err) {
    // Falls back to the env var instead of throwing if the table hasn't
    // been migrated onto this environment's DB yet — every payment
    // initiation calls through here (via isConfigured()), so a schema
    // mismatch here shouldn't take down live payment processing.
    console.error("payment_credentials read failed, falling back to env var:", err);
    return undefined;
  }
  const row = res.rows[0] as unknown as Row | undefined;
  if (!row) return undefined;
  try {
    return await decryptSecret(row.value);
  } catch {
    return undefined;
  }
}

/** Resolves one credential field: DB value if an admin has saved one,
 * otherwise the env var this field falls back to. */
export async function getCredential(provider: PaymentProviderIdentity, field: string): Promise<string | undefined> {
  const stored = await readStored(provider, field);
  if (stored) return stored;
  const def = PROVIDER_CREDENTIAL_FIELDS[provider].find((f) => f.key === field);
  const envVar = def?.envVar;
  return envVar ? process.env[envVar] || undefined : undefined;
}

/** Whether every *required* field for this provider resolves to something
 * (DB or env fallback) — the same "is this aggregator actually usable"
 * check ../service.ts's isConfigured() needs. */
export async function isProviderConfigured(provider: PaymentProviderIdentity): Promise<boolean> {
  const required = PROVIDER_CREDENTIAL_FIELDS[provider].filter((f) => f.required);
  const values = await Promise.all(required.map((f) => getCredential(provider, f.key)));
  return values.every((v) => !!v);
}

/** Field-by-field "is something set" status for the admin UI — never the
 * actual values, DB-stored or env-fallback alike. */
export async function credentialFieldStatus(provider: PaymentProviderIdentity) {
  const fields = PROVIDER_CREDENTIAL_FIELDS[provider];
  return Promise.all(
    fields.map(async (f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      required: f.required,
      placeholder: f.placeholder,
      helpText: f.helpText,
      set: !!(await getCredential(provider, f.key)),
    })),
  );
}

/**
 * Saves whichever fields were submitted (blank/omitted fields are left
 * untouched — an admin re-saving one field shouldn't wipe the others).
 * Returns which field keys actually changed, for the activity log — never
 * the values themselves.
 */
export async function saveCredentials(
  provider: PaymentProviderIdentity,
  fields: Record<string, string>,
): Promise<string[]> {
  const validKeys = new Set(PROVIDER_CREDENTIAL_FIELDS[provider].map((f) => f.key));
  const changed: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!validKeys.has(key)) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const encrypted = await encryptSecret(trimmed);
    await db.execute({
      sql: `INSERT INTO payment_credentials (provider, field, value, updated_at) VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT(provider, field) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [provider, key, encrypted],
    });
    changed.push(key);
  }
  return changed;
}

/** Clears one saved field, reverting that provider back to its env-var
 * fallback (if any) for that field. */
export async function clearCredential(provider: PaymentProviderIdentity, field: string): Promise<void> {
  await db.execute({
    sql: "DELETE FROM payment_credentials WHERE provider = ? AND field = ?",
    args: [provider, field],
  });
}
