"use client";

import type { AdminStats, FailedPayment, IntegrationsStatus } from "@tuma/shared";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { formatUgx, formatDate } from "../lib/order-display";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="home-card !p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-ink">{value}</p>
    </div>
  );
}

export default function OverviewPage() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationsStatus | null>(null);
  const [failedPayments, setFailedPayments] = useState<FailedPayment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.adminStats(), api.adminIntegrations()])
      .then(([s, i]) => {
        setStats(s.stats);
        setIntegrations(i.integrations);
        setFailedPayments(i.recentFailedPayments);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  if (error) {
    return <p className="m-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>;
  }
  if (!stats || !integrations) {
    return <div className="p-4 text-sm text-ink-500">Loading…</div>;
  }

  const activeOrders = Object.entries(stats.ordersByStage)
    .filter(([stage]) => stage !== "Settle")
    .reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Overview</h1>

      {/* The single most dangerous thing about this deployment is someone
          treating a wallet balance or a GMV figure as real money while
          payments are mocked. It gets a banner, not a line item. */}
      {!integrations.mobileMoney.collection.live && (
        <section
          role="alert"
          className="flex items-start gap-2.5 rounded-xl border-2 border-red-500 bg-red-50 px-3.5 py-3 dark:bg-red-950/40"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-red-600" strokeWidth={2.25} aria-hidden />
          <div className="space-y-1">
            <p className="text-sm font-bold uppercase tracking-wide text-red-700 dark:text-red-400">
              Simulated payments
            </p>
            <p className="text-xs leading-relaxed text-red-700 dark:text-red-300">
              No real money moves. Escrow collections succeed without charging anyone, rider wallet balances are
              fictional, and withdrawals pay out nothing. Every figure below is test data — don&apos;t onboard real
              riders or settle real orders until mobile money is live.
            </p>
          </div>
        </section>
      )}

      <section className="grid grid-cols-2 gap-3">
        <StatCard label="Customers" value={stats.totalCustomers} />
        <StatCard label="Riders" value={stats.totalRiders} />
        <StatCard label="Verified riders" value={stats.verifiedRiders} />
        <StatCard label="Online now" value={stats.onlineRiders} />
        <StatCard label="Active orders" value={activeOrders} />
        <StatCard label="Settled GMV" value={formatUgx(stats.settledGmv)} />
      </section>

      <section className="home-card space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Payments</h2>
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-500">Pending</span>
          <span className="font-semibold text-ink">{stats.paymentsByStatus.pending ?? 0}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-500">Successful</span>
          <span className="font-semibold text-ink">{stats.paymentsByStatus.successful ?? 0}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-ink-500">Failed</span>
          <span className="font-semibold text-red-700">{stats.paymentsByStatus.failed ?? 0}</span>
        </div>
      </section>

      <section className="home-card space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Integrations</h2>
        {integrations.mobileMoney.providers.map((provider) => (
          <div key={provider.key} className="flex items-center gap-2 text-sm">
            {provider.configured ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-green" strokeWidth={2} aria-hidden />
            ) : (
              <span className="h-4 w-4 shrink-0 rounded-full bg-gold/70" aria-hidden />
            )}
            <span className="text-ink">
              {provider.displayName} — {provider.configured ? "connected" : "demo / simulated"}
              {provider.active ? (provider.priority === 0 ? " · primary" : " · fallback") : " · off"}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-2 text-sm">
          {integrations.storage.configured ? (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-green" strokeWidth={2} aria-hidden />
          ) : (
            <XCircle className="h-4 w-4 shrink-0 text-red-600" strokeWidth={2} aria-hidden />
          )}
          <span className="text-ink">
            R2 document storage — {integrations.storage.configured ? "connected" : "not connected"}
          </span>
        </div>

        {failedPayments.length > 0 && (
          <div className="space-y-1.5 border-t border-[var(--border-faint)] pt-3">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-red-700">
              <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Recent failed payments
            </p>
            <ul className="space-y-1">
              {failedPayments.map((p) => (
                <li key={p.id} className="flex items-center justify-between text-xs text-ink-500">
                  <span>
                    {p.type} · {formatDate(p.created_at)}
                  </span>
                  <span className="font-semibold text-ink">{formatUgx(p.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
