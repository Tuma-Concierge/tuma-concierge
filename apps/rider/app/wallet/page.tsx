"use client";

import type { OrderRow, Wallet } from "@tuma/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { formatUgx } from "../../lib/order-display";

const WITHDRAWAL_STATUS_LABEL: Record<Wallet["withdrawals"][number]["status"], string> = {
  pending: "Processing",
  successful: "Paid out",
  failed: "Failed — refunded",
};

export default function WalletPage() {
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const polling = useRef(false);

  const load = useCallback(async () => {
    const [walletRes, ordersRes] = await Promise.all([
      api.myWallet(),
      api.myRiderOrders().catch(() => ({ orders: [] as OrderRow[] })),
    ]);
    setWallet(walletRes);
    setOrders(ordersRes.orders.filter((o) => o.stage === "Settle"));
    return walletRes;
  }, []);

  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  // Poll while a withdrawal is still pending — mirrors the customer app's
  // payment-refresh pattern, since sandbox mobile money has no webhook.
  useEffect(() => {
    const pending = wallet?.withdrawals.find((w) => w.status === "pending");
    if (!pending || polling.current) return;
    polling.current = true;
    const interval = setInterval(async () => {
      try {
        await api.refreshWithdrawal(pending.id);
        await load();
      } catch {
        // keep polling — a transient error shouldn't stop it
      }
    }, 4000);
    return () => {
      clearInterval(interval);
      polling.current = false;
    };
  }, [wallet, load]);

  async function withdraw() {
    setBusy(true);
    setError(null);
    try {
      await api.withdrawWallet();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const settledTotal = orders.reduce((sum, o) => sum + (o.final_total ?? o.estimated_total ?? 0), 0);

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Wallet</h1>

      <section className="home-card space-y-3 text-center">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Wallet balance</p>
          <p className="text-2xl font-bold text-ink">{wallet ? formatUgx(wallet.balance) : "—"}</p>
          <p className="text-xs text-ink-500">Escrow payouts land here — cash jobs pay you directly, on the spot.</p>
        </div>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <button
          onClick={withdraw}
          disabled={busy || !wallet || wallet.balance <= 0}
          className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-50"
        >
          {busy ? "Sending…" : "Withdraw to mobile money"}
        </button>
      </section>

      {wallet && wallet.withdrawals.length > 0 && (
        <section className="space-y-2.5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Withdrawals</h2>
          <ul className="space-y-2">
            {wallet.withdrawals.map((w) => (
              <li key={w.id} className="home-card flex items-center justify-between !rounded-2xl !px-3 !py-3">
                <div>
                  <span className="block text-sm text-ink">{formatUgx(w.amount)}</span>
                  <span className="block text-xs text-ink-500">{new Date(w.created_at).toLocaleDateString()}</span>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${
                    w.status === "successful"
                      ? "bg-green/15 text-green"
                      : w.status === "failed"
                        ? "bg-red-100 text-red-700"
                        : "bg-[rgb(var(--surface-muted))] text-ink-500"
                  }`}
                >
                  {WITHDRAWAL_STATUS_LABEL[w.status]}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">
          Job history · {formatUgx(settledTotal)} lifetime
        </h2>
        {orders.length === 0 && <p className="py-6 text-center text-sm text-ink-500">No completed jobs yet.</p>}
        <ul className="space-y-2">
          {orders.map((order) => (
            <li key={order.id} className="home-card flex items-center justify-between !rounded-2xl !px-3 !py-3">
              <span className="text-sm text-ink">{order.destination_area ?? `Job #${order.id.slice(-6)}`}</span>
              <span className="text-sm font-semibold text-green">
                {formatUgx(order.final_total ?? order.estimated_total)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
