"use client";

import { ORDER_STAGES, type AdminOrderRow, type OrderType } from "@tuma/shared";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { formatUgx, orderTitle, stageLabel } from "../../lib/order-display";

type TypeFilter = "all" | OrderType;

export default function OrdersPage() {
  const [orders, setOrders] = useState<AdminOrderRow[]>([]);
  const [stage, setStage] = useState<string>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .adminListOrders({
        stage: stage === "all" ? undefined : stage,
        type: type === "all" ? undefined : type,
        limit: 50,
      })
      .then((res) => setOrders(res.orders))
      .catch((err) => setError(errorMessage(err)));
  }, [stage, type]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <div className="space-y-4 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Orders</h1>

      <div className="flex gap-2 overflow-x-auto pb-1">
        {(["all", "shopping", "parcel"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${
              type === t ? "bg-ink text-white" : "bg-[rgb(var(--surface-muted))] text-ink-500"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex gap-2 overflow-x-auto pb-1">
        {["all", ...ORDER_STAGES].map((s) => (
          <button
            key={s}
            onClick={() => setStage(s)}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${
              stage === s ? "bg-gold text-ink-gold" : "bg-[rgb(var(--surface-muted))] text-ink-500"
            }`}
          >
            {s === "all" ? "All" : stageLabel(s)}
          </button>
        ))}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {orders.length === 0 && <p className="py-6 text-center text-sm text-ink-500">No orders match.</p>}

      <ul className="space-y-2.5">
        {orders.map((order) => (
          <li key={order.id}>
            <Link href={`/orders/${order.id}`} className="home-card flex items-center gap-3 !rounded-2xl !px-3 !py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-ink">{orderTitle(order)}</span>
                <span className="mt-0.5 block truncate text-xs text-ink-500">
                  {stageLabel(order.stage, order.type)}
                  {order.rider_name ? ` · ${order.rider_name}` : ""}
                </span>
              </span>
              <span className="shrink-0 text-sm font-semibold text-ink">
                {formatUgx(order.final_total ?? order.estimated_total)}
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-ink-500/60" strokeWidth={1.75} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
