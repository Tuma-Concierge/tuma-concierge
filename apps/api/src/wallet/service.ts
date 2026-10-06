/**
 * Customer wallet ledger — the one place balance actually moves, so every
 * credit/debit is both applied to users.wallet_balance and recorded in
 * wallet_ledger in the same call. The running balance is a cache; the
 * ledger is the source of truth an admin (or a support dispute) can always
 * reconstruct it from.
 */

import { db } from "../db/client.js";
import { newId } from "../lib/ids.js";
import { getWalletSettings, type PlatformEnvironment } from "../lib/settings.js";

type Row = Record<string, unknown>;

export type LedgerType = "topup" | "order_payment" | "refund" | "adjustment" | "transfer_out" | "transfer_in";

/** `users.wallet_balance` is the live column (unrenamed, so every
 * pre-sandbox caller keeps working); `wallet_balance_sandbox` is its
 * counterpart — see migrations/0030_sandbox_live_state.sql. Every
 * credit/debit in this file requires an explicit environment rather than
 * defaulting to one, so a caller can't accidentally move real money on a
 * sandbox action or vice versa. */
function balanceColumn(environment: PlatformEnvironment): "wallet_balance" | "wallet_balance_sandbox" {
  return environment === "sandbox" ? "wallet_balance_sandbox" : "wallet_balance";
}

export async function getWalletCap(userId: string): Promise<{ cap: number; verified: boolean }> {
  const res = await db.execute({
    sql: "SELECT phone_verified_at, email_verified_at FROM users WHERE id = ?",
    args: [userId],
  });
  const row = res.rows[0] as Row | undefined;
  const verified = !!(row?.phone_verified_at || row?.email_verified_at);
  const settings = await getWalletSettings();
  return { cap: verified ? settings.verifiedCap : settings.unverifiedCap, verified };
}

async function recordLedgerEntry(input: {
  userId: string;
  type: LedgerType;
  amount: number;
  balanceAfter: number;
  environment: PlatformEnvironment;
  orderId?: string;
  topupId?: string;
  counterpartyId?: string;
  note?: string;
  actorId?: string;
}): Promise<void> {
  await db.execute({
    sql: `INSERT INTO wallet_ledger (id, user_id, type, amount, balance_after, order_id, topup_id, counterparty_id, note, actor_id, environment)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      newId("wl"),
      input.userId,
      input.type,
      input.amount,
      input.balanceAfter,
      input.orderId ?? null,
      input.topupId ?? null,
      input.counterpartyId ?? null,
      input.note ?? null,
      input.actorId ?? null,
      input.environment,
    ],
  });
}

/** Always succeeds (crediting has no failure mode besides a DB error) —
 * returns the balance afterward. */
export async function creditWallet(
  userId: string,
  amount: number,
  info: {
    type: LedgerType;
    environment: PlatformEnvironment;
    orderId?: string;
    topupId?: string;
    counterpartyId?: string;
    note?: string;
    actorId?: string;
  },
): Promise<number> {
  const column = balanceColumn(info.environment);
  await db.execute({
    sql: `UPDATE users SET ${column} = ${column} + ?, updated_at = datetime('now') WHERE id = ?`,
    args: [amount, userId],
  });
  const res = await db.execute({ sql: `SELECT ${column} as balance FROM users WHERE id = ?`, args: [userId] });
  const balance = Number((res.rows[0] as Row)?.balance ?? 0);
  await recordLedgerEntry({ userId, amount, balanceAfter: balance, ...info });
  return balance;
}

/**
 * Debits iff the balance covers it — the WHERE clause makes the check and
 * the write atomic in one statement, so two requests racing to spend the
 * same balance can't both succeed (the loser's UPDATE simply matches zero
 * rows). Returns the balance afterward, or null if there wasn't enough.
 */
export async function debitWallet(
  userId: string,
  amount: number,
  info: {
    type: LedgerType;
    environment: PlatformEnvironment;
    orderId?: string;
    counterpartyId?: string;
    note?: string;
    actorId?: string;
  },
): Promise<number | null> {
  const column = balanceColumn(info.environment);
  const res = await db.execute({
    sql: `UPDATE users SET ${column} = ${column} - ?, updated_at = datetime('now') WHERE id = ? AND ${column} >= ?`,
    args: [amount, userId, amount],
  });
  if ((res.rowsAffected ?? 0) === 0) return null;
  const balanceRes = await db.execute({ sql: `SELECT ${column} as balance FROM users WHERE id = ?`, args: [userId] });
  const balance = Number((balanceRes.rows[0] as Row)?.balance ?? 0);
  await recordLedgerEntry({ userId, amount: -amount, balanceAfter: balance, ...info });
  return balance;
}

/**
 * Pays for an order directly out of the customer's wallet — debits the
 * ledger and, in the same call, inserts a `payments` row exactly like a
 * successful mobile money collection would (provider "wallet", already
 * `status = 'successful'` since there's no external gateway round trip to
 * wait on). That's what lets this slot into the existing escrow/settle
 * accounting — POST /orders/:id/settle sums successful collections
 * regardless of provider, so a wallet-funded order pays the rider out the
 * same way an escrow one does, with no changes needed there.
 *
 * `actorId` is who actually triggered the payment when that's someone
 * other than the wallet owner — a grantee spending from a wallet shared
 * with them (see wallet_shares). Omitted (left null) for an ordinary
 * self-payment, so the ledger only needs an attribution line when there's
 * actually someone else to attribute it to.
 *
 * Returns the new payments.id, or null if the balance was insufficient.
 */
export async function payFromWallet(input: {
  userId: string;
  amount: number;
  orderId: string;
  environment: PlatformEnvironment;
  note?: string;
  actorId?: string;
}): Promise<string | null> {
  const balance = await debitWallet(input.userId, input.amount, {
    type: "order_payment",
    environment: input.environment,
    orderId: input.orderId,
    note: input.note,
    actorId: input.actorId,
  });
  if (balance === null) return null;

  const paymentId = newId("pay");
  await db.execute({
    sql: `INSERT INTO payments (id, order_id, type, provider, provider_ref, amount, currency, status)
          VALUES (?, ?, 'collection', 'wallet', NULL, ?, 'UGX', 'successful')`,
    args: [paymentId, input.orderId, input.amount],
  });
  return paymentId;
}

/**
 * Admin-issued refund of an order's collected payment(s) back to the
 * customer's wallet — the confirmed shape for "refunds from cancelled
 * orders return to the wallet" without a full self-service cancellation
 * flow (which doesn't exist in the app yet; this is a deliberate scope
 * boundary, see the wallet feature's design notes). Refunds at most what
 * was actually collected for the order, and only once.
 */
export async function refundOrderToWallet(input: {
  orderId: string;
  customerId: string;
  actorId: string;
  /** The order's own environment — the refund always lands in the same
   * balance the original collection would have paid out of, regardless of
   * whatever's currently active. */
  environment: PlatformEnvironment;
  note?: string;
}): Promise<{ refunded: number } | { error: "nothing_to_refund" | "already_refunded" }> {
  const [collectedRes, refundedRes] = await Promise.all([
    db.execute({
      sql: "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE order_id = ? AND type = 'collection' AND status = 'successful'",
      args: [input.orderId],
    }),
    db.execute({
      sql: "SELECT COALESCE(SUM(amount), 0) as total FROM payments WHERE order_id = ? AND type = 'refund' AND status = 'successful'",
      args: [input.orderId],
    }),
  ]);
  const collected = Number((collectedRes.rows[0] as Row)?.total ?? 0);
  const alreadyRefunded = Number((refundedRes.rows[0] as Row)?.total ?? 0);
  const refundable = collected - alreadyRefunded;
  if (collected === 0) return { error: "nothing_to_refund" };
  if (refundable <= 0) return { error: "already_refunded" };

  await db.execute({
    sql: `INSERT INTO payments (id, order_id, type, provider, provider_ref, amount, currency, status)
          VALUES (?, ?, 'refund', 'wallet', NULL, ?, 'UGX', 'successful')`,
    args: [newId("pay"), input.orderId, refundable],
  });
  await creditWallet(input.customerId, refundable, {
    type: "refund",
    environment: input.environment,
    orderId: input.orderId,
    note: input.note ?? "Order refund",
    actorId: input.actorId,
  });
  return { refunded: refundable };
}

/** Finds an active customer by exact phone or email match — used to
 * resolve who a transfer or a wallet-share invite is for. Exact match
 * only (not LIKE): this is a money-moving lookup, not a search box, so
 * it shouldn't return anyone other than exactly who was typed. */
export async function resolveCustomerByIdentifier(identifier: string): Promise<{ id: string; name: string } | null> {
  const value = identifier.trim();
  if (!value) return null;
  const res = await db.execute({
    sql: "SELECT id, name FROM users WHERE role = 'customer' AND status = 'active' AND (phone = ? OR lower(email) = lower(?)) LIMIT 1",
    args: [value, value],
  });
  const row = res.rows[0] as Row | undefined;
  if (!row) return null;
  return { id: row.id as string, name: row.name as string };
}

/**
 * Moves money directly from one customer's wallet into another's — still
 * closed-loop (it never leaves to mobile money), just a wallet-to-wallet
 * move instead of wallet-to-order. Debit-then-credit as two separate
 * statements rather than one DB transaction (the `db` client here doesn't
 * expose one) — the same residual-risk shape payFromWallet already
 * accepts for debit-then-insert-payment: wallet_ledger is always
 * reconstructable/auditable if the two ever needed reconciling.
 *
 * Returns both balances afterward, or null if the sender's balance was
 * insufficient. Caller is responsible for checking the recipient's cap
 * beforehand (this only enforces the sender has the funds).
 */
export async function transferWallet(input: {
  fromUserId: string;
  toUserId: string;
  amount: number;
  environment: PlatformEnvironment;
  note?: string;
}): Promise<{ fromBalance: number; toBalance: number } | null> {
  const fromBalance = await debitWallet(input.fromUserId, input.amount, {
    type: "transfer_out",
    environment: input.environment,
    counterpartyId: input.toUserId,
    note: input.note,
  });
  if (fromBalance === null) return null;

  const toBalance = await creditWallet(input.toUserId, input.amount, {
    type: "transfer_in",
    environment: input.environment,
    counterpartyId: input.fromUserId,
    note: input.note,
  });
  return { fromBalance, toBalance };
}
