"use client";

import { hasPermission, type AdminCustomer, type AdminOrderRow } from "@tuma/shared";
import { ArrowLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../../lib/api";
import { useAuth } from "../../../../lib/auth-context";
import { formatUgx, orderTitle, stageLabel } from "../../../../lib/order-display";

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;
  const { user } = useAuth();
  const canManage = hasPermission(user?.adminRole ?? null, "customers.manage");
  const canManagePayments = hasPermission(user?.adminRole ?? null, "payments.manage");
  const [customer, setCustomer] = useState<AdminCustomer | null>(null);
  const [orders, setOrders] = useState<AdminOrderRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refundedOrderId, setRefundedOrderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.adminGetCustomer(customerId);
    setCustomer(res.customer);
    setOrders(res.orders);
  }, [customerId]);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err)));
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function refundToWallet(orderId: string) {
    setBusy(true);
    setError(null);
    setRefundedOrderId(null);
    try {
      await api.adminRefundToWallet(orderId);
      setRefundedOrderId(orderId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!customer) {
    return <div className="p-4 text-sm text-ink-500">{error ?? "Loading customer…"}</div>;
  }

  const suspended = customer.status === "suspended";

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <Link href="/people" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
        People
      </Link>

      <header>
        <h1 className="text-xl font-bold text-ink">{customer.name}</h1>
        <p className="text-sm text-ink-500">
          {customer.phone}
          {customer.email ? ` · ${customer.email}` : ""}
        </p>
      </header>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Orders</h2>
        {orders.length === 0 && <p className="py-4 text-center text-sm text-ink-500">No orders yet.</p>}
        <ul className="space-y-2.5">
          {orders.map((order) => (
            <li key={order.id} className="home-card space-y-2 !rounded-2xl !px-3 !py-3">
              <Link href={`/orders/${order.id}`} className="flex items-center gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-ink">{orderTitle(order)}</span>
                  <span className="mt-0.5 block text-xs text-ink-500">
                    {stageLabel(order.stage, order.type)} · {formatUgx(order.final_total ?? order.estimated_total)}
                  </span>
                </span>
                <ChevronRight className="h-5 w-5 shrink-0 text-ink-500/60" strokeWidth={1.75} aria-hidden />
              </Link>
              {canManagePayments && order.stage !== "Create" && (
                <div className="flex items-center gap-2 border-t border-[var(--border-faint)] pt-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => refundToWallet(order.id)}
                    className="text-xs font-semibold text-gold disabled:opacity-60"
                  >
                    Refund to wallet
                  </button>
                  {refundedOrderId === order.id && <span className="text-xs font-semibold text-green">Refunded</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canManage && (
        <button
          disabled={busy}
          onClick={() => run(() => api.adminSetUserStatus(customerId, suspended ? "active" : "suspended"))}
          className={`min-h-11 w-full rounded-full px-4 text-sm font-bold disabled:opacity-60 ${
            suspended ? "bg-green text-white" : "border border-red-200 text-red-700"
          }`}
        >
          {suspended ? "Reactivate account" : "Suspend account"}
        </button>
      )}
    </div>
  );
}
