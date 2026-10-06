"use client";

import type { CustomerWallet, WalletLedgerEntry, WalletShares } from "@tuma/shared";
import { detectMobileMoneyNetwork, mobileMoneyNetworkLabel } from "@tuma/shared";
import { ArrowDownLeft, ArrowUpRight, RotateCcw, Send, Users, Wallet as WalletIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useNetworkStatus } from "../../lib/use-network-status";
import { formatDateTime, formatUgx } from "../../lib/order-display";

const LEDGER_ICONS = {
  topup: ArrowDownLeft,
  order_payment: ArrowUpRight,
  refund: RotateCcw,
  adjustment: WalletIcon,
  transfer_out: ArrowUpRight,
  transfer_in: ArrowDownLeft,
} as const;

const LEDGER_LABELS: Record<string, string> = {
  topup: "Top-up",
  order_payment: "Order payment",
  refund: "Refund",
  adjustment: "Adjustment",
};

function ledgerLabel(entry: WalletLedgerEntry): string {
  if (entry.type === "transfer_out") return `Sent to ${entry.counterparty_name ?? "another customer"}`;
  if (entry.type === "transfer_in") return `Received from ${entry.counterparty_name ?? "another customer"}`;
  return LEDGER_LABELS[entry.type] ?? entry.type;
}

const SHARE_STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  active: "Active",
  revoked: "Revoked",
  declined: "Declined",
};

export default function WalletPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [wallet, setWallet] = useState<CustomerWallet | null>(null);
  const [amount, setAmount] = useState("");
  const [msisdn, setMsisdn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingTopupId, setPendingTopupId] = useState<string | null>(null);
  const detectedNetwork = useMemo(() => detectMobileMoneyNetwork(msisdn), [msisdn]);
  const online = useNetworkStatus();

  const [showSend, setShowSend] = useState(false);
  const [sendRecipient, setSendRecipient] = useState("");
  const [sendAmount, setSendAmount] = useState("");
  const [sendNote, setSendNote] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sendSuccess, setSendSuccess] = useState<string | null>(null);

  const [shares, setShares] = useState<WalletShares | null>(null);
  const [showShareInvite, setShowShareInvite] = useState(false);
  const [shareRecipient, setShareRecipient] = useState("");
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [respondingId, setRespondingId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .getWallet()
      .then(setWallet)
      .catch(() => {});
  }, []);

  const loadShares = useCallback(() => {
    api
      .getWalletShares()
      .then(setShares)
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    loadShares();
  }, [load, loadShares]);

  // Returning from a hosted checkout (Flutterwave) — resume polling for
  // whichever top-up sent them there.
  useEffect(() => {
    const returned = searchParams.get("topup_return");
    if (returned) {
      setPendingTopupId(returned);
      router.replace("/wallet");
    }
  }, [searchParams, router]);

  useEffect(() => {
    if (!pendingTopupId) return;
    const interval = setInterval(() => {
      api
        .refreshTopup(pendingTopupId)
        .then((res) => {
          if (res.topup.status !== "pending") {
            setPendingTopupId(null);
            load();
          }
        })
        .catch(() => {});
    }, 3000);
    return () => clearInterval(interval);
  }, [pendingTopupId, load]);

  async function submitTopup(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      setError("Enter an amount to top up.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.topUpWallet({ amount: parsedAmount, msisdn: msisdn || undefined });
      if (res.redirectUrl) {
        window.location.href = res.redirectUrl;
        return;
      }
      setPendingTopupId(res.topupId);
      setAmount("");
      setMsisdn("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitTransfer(e: React.FormEvent) {
    e.preventDefault();
    const parsedAmount = Number(sendAmount);
    if (!sendRecipient.trim()) {
      setSendError("Enter the recipient's phone number or email.");
      return;
    }
    if (!parsedAmount || parsedAmount <= 0) {
      setSendError("Enter an amount to send.");
      return;
    }
    setSendBusy(true);
    setSendError(null);
    try {
      const res = await api.transferWallet({
        recipient: sendRecipient.trim(),
        amount: parsedAmount,
        note: sendNote.trim() || undefined,
      });
      setSendSuccess(`Sent ${formatUgx(parsedAmount)} to ${res.recipientName}.`);
      setSendRecipient("");
      setSendAmount("");
      setSendNote("");
      setShowSend(false);
      load();
    } catch (err) {
      setSendError(errorMessage(err));
    } finally {
      setSendBusy(false);
    }
  }

  async function submitShareInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!shareRecipient.trim()) {
      setShareError("Enter the person's phone number or email.");
      return;
    }
    setShareBusy(true);
    setShareError(null);
    try {
      await api.shareWallet({ recipient: shareRecipient.trim() });
      setShareRecipient("");
      setShowShareInvite(false);
      loadShares();
    } catch (err) {
      setShareError(errorMessage(err));
    } finally {
      setShareBusy(false);
    }
  }

  async function respondShare(id: string, action: "accept" | "decline" | "revoke") {
    setRespondingId(id);
    try {
      if (action === "accept") await api.acceptWalletShare(id);
      else if (action === "decline") await api.declineWalletShare(id);
      else await api.revokeWalletShare(id);
      loadShares();
    } catch {
      // Best-effort — a stale row just won't reflect the action; the next reload fixes it.
    } finally {
      setRespondingId(null);
    }
  }

  if (!wallet) {
    return <div className="p-4 text-sm text-ink-500">Loading wallet…</div>;
  }

  const pctUsed = wallet.cap > 0 ? Math.min(100, Math.round((wallet.balance / wallet.cap) * 100)) : 0;

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Wallet</h1>

      <section className="home-card space-y-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Balance</p>
          <p className="text-3xl font-bold text-ink">{formatUgx(wallet.balance)}</p>
        </div>
        <div className="space-y-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgb(var(--surface-muted))]">
            <div className="h-full rounded-full bg-gold" style={{ width: `${pctUsed}%` }} />
          </div>
          <p className="text-xs text-ink-500">
            Up to {formatUgx(wallet.cap)} {wallet.verified ? "(verified account)" : "(verify your phone or email to raise this)"}
          </p>
        </div>
      </section>

      <section className="home-card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Top up</h2>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {pendingTopupId ? (
          <div className="flex items-center gap-3 py-2">
            <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-gold border-t-transparent" />
            <p className="text-sm text-ink-500">Confirming your top-up…</p>
          </div>
        ) : (
          <form onSubmit={submitTopup} className="space-y-2">
            {!online && (
              <p className="rounded-lg bg-gold/10 px-3 py-2 text-xs font-semibold text-ink-500">
                You&apos;re offline — topping up needs a connection.
              </p>
            )}
            <input
              required
              inputMode="numeric"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="Amount (UGX)"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
            />
            <div className="space-y-1">
              <input
                required
                value={msisdn}
                onChange={(e) => setMsisdn(e.target.value)}
                placeholder="Mobile money number (e.g. 0772345678)"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              {detectedNetwork && (
                <p className="px-1 text-xs font-semibold text-ink-500">{mobileMoneyNetworkLabel(detectedNetwork)} detected</p>
              )}
            </div>
            <button
              type="submit"
              disabled={busy || !online}
              className="min-h-12 w-full rounded-full bg-gold px-4 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-60"
            >
              {busy ? "Starting…" : "Top up"}
            </button>
          </form>
        )}
      </section>

      <section className="home-card space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Send money</h2>
          {!showSend && (
            <button
              type="button"
              onClick={() => {
                setShowSend(true);
                setSendSuccess(null);
              }}
              disabled={!online}
              className="flex items-center gap-1.5 rounded-full bg-[rgb(var(--surface-muted))] px-3 py-1.5 text-xs font-bold text-ink disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Send
            </button>
          )}
        </div>
        {sendSuccess && !showSend && <p className="rounded-lg bg-green/10 px-3 py-2 text-sm text-green">{sendSuccess}</p>}
        {showSend && (
          <form onSubmit={submitTransfer} className="space-y-2">
            {sendError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{sendError}</p>}
            <input
              required
              value={sendRecipient}
              onChange={(e) => setSendRecipient(e.target.value)}
              placeholder="Recipient's phone or email"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
            />
            <input
              required
              inputMode="numeric"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value.replace(/[^\d]/g, ""))}
              placeholder="Amount (UGX)"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
            />
            <input
              value={sendNote}
              onChange={(e) => setSendNote(e.target.value.slice(0, 140))}
              placeholder="Note (optional)"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowSend(false);
                  setSendError(null);
                }}
                className="min-h-11 flex-1 rounded-full border border-[var(--border-faint)] text-sm font-bold text-ink"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={sendBusy || !online}
                className="min-h-11 flex-[2] rounded-full bg-gold text-sm font-bold text-ink-gold disabled:opacity-60"
              >
                {sendBusy ? "Sending…" : "Send"}
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="home-card space-y-3">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-ink-500" strokeWidth={2} aria-hidden />
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Shared wallets</h2>
        </div>

        {shares && shares.received.filter((r) => r.status === "pending").length > 0 && (
          <div className="space-y-2">
            {shares.received
              .filter((r) => r.status === "pending")
              .map((r) => (
                <div key={r.id} className="space-y-2 rounded-xl border border-[var(--border-faint)] p-3">
                  <p className="text-sm text-ink">
                    <span className="font-bold">{r.owner_name}</span> wants to share their wallet with you.
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => respondShare(r.id, "decline")}
                      disabled={respondingId === r.id}
                      className="min-h-9 flex-1 rounded-full border border-[var(--border-faint)] text-xs font-bold text-ink disabled:opacity-60"
                    >
                      Decline
                    </button>
                    <button
                      type="button"
                      onClick={() => respondShare(r.id, "accept")}
                      disabled={respondingId === r.id}
                      className="min-h-9 flex-1 rounded-full bg-gold text-xs font-bold text-ink-gold disabled:opacity-60"
                    >
                      Accept
                    </button>
                  </div>
                </div>
              ))}
          </div>
        )}

        {shares && shares.received.filter((r) => r.status === "active").length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-ink-500">Shared with you</p>
            {shares.received
              .filter((r) => r.status === "active")
              .map((r) => (
                <div key={r.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-faint)] p-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-ink">{r.owner_name}</span>
                    <span className="block text-xs text-ink-500">
                      {r.owner_balance != null ? `${formatUgx(r.owner_balance)} available` : "Active"}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => respondShare(r.id, "revoke")}
                    disabled={respondingId === r.id}
                    className="shrink-0 rounded-full bg-[rgb(var(--surface-muted))] px-3 py-1.5 text-xs font-bold text-ink disabled:opacity-60"
                  >
                    Stop
                  </button>
                </div>
              ))}
          </div>
        )}

        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold text-ink-500">People you&apos;ve shared with</p>
            {!showShareInvite && (
              <button
                type="button"
                onClick={() => setShowShareInvite(true)}
                disabled={!online}
                className="text-xs font-bold text-gold disabled:opacity-50"
              >
                + Share your wallet
              </button>
            )}
          </div>
          {shares && shares.granted.length === 0 && !showShareInvite && (
            <p className="text-xs text-ink-500">You haven&apos;t shared your wallet with anyone.</p>
          )}
          {shares?.granted.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border-faint)] p-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold text-ink">{g.grantee_name}</span>
                <span className="block text-xs text-ink-500">{SHARE_STATUS_LABELS[g.status] ?? g.status}</span>
              </span>
              {(g.status === "pending" || g.status === "active") && (
                <button
                  type="button"
                  onClick={() => respondShare(g.id, "revoke")}
                  disabled={respondingId === g.id}
                  className="shrink-0 rounded-full bg-[rgb(var(--surface-muted))] px-3 py-1.5 text-xs font-bold text-ink disabled:opacity-60"
                >
                  Revoke
                </button>
              )}
            </div>
          ))}
          {showShareInvite && (
            <form onSubmit={submitShareInvite} className="space-y-2 pt-1">
              {shareError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{shareError}</p>}
              <input
                required
                value={shareRecipient}
                onChange={(e) => setShareRecipient(e.target.value)}
                placeholder="Their phone or email"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setShowShareInvite(false);
                    setShareError(null);
                  }}
                  className="min-h-10 flex-1 rounded-full border border-[var(--border-faint)] text-xs font-bold text-ink"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={shareBusy || !online}
                  className="min-h-10 flex-[2] rounded-full bg-gold text-xs font-bold text-ink-gold disabled:opacity-60"
                >
                  {shareBusy ? "Inviting…" : "Send invite"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Activity</h2>
        {wallet.ledger.length === 0 && <p className="py-6 text-center text-sm text-ink-500">No wallet activity yet.</p>}
        <ul className="space-y-2">
          {wallet.ledger.map((entry) => {
            const Icon = LEDGER_ICONS[entry.type] ?? WalletIcon;
            const isCredit = entry.amount > 0;
            return (
              <li key={entry.id} className="home-card flex items-center gap-3 !rounded-2xl !px-3 !py-3">
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
                    isCredit ? "bg-green/15 text-green" : "bg-[rgb(var(--surface-muted))] text-ink-500"
                  }`}
                >
                  <Icon className="h-4 w-4" strokeWidth={2} aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-ink">{ledgerLabel(entry)}</span>
                  <span className="block truncate text-xs text-ink-500">
                    {formatDateTime(entry.created_at)}
                    {entry.actor_name ? ` · by ${entry.actor_name}` : ""}
                  </span>
                </span>
                <span className={`shrink-0 text-sm font-bold ${isCredit ? "text-green" : "text-ink"}`}>
                  {isCredit ? "+" : ""}
                  {formatUgx(entry.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
