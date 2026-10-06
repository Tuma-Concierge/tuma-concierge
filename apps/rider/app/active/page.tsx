"use client";

import type { OrderRow } from "@tuma/shared";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { jobTitle, stageLabel } from "../../lib/order-display";

export default function ActivePage() {
  const [orders, setOrders] = useState<OrderRow[] | null>(null);

  useEffect(() => {
    api
      .myRiderOrders()
      .then((res) => setOrders(res.orders.filter((o) => o.stage !== "Settle")))
      .catch(() => setOrders([]));
  }, []);

  if (orders === null) return <div className="p-4 text-sm text-ink-500">Loading…</div>;

  return (
    <div className="space-y-4 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Active</h1>
      {orders.length === 0 && <p className="py-10 text-center text-sm text-ink-500">No active jobs right now.</p>}
      <ul className="space-y-2.5">
        {orders.map((order) => (
          <li key={order.id}>
            <Link href={`/jobs/${order.id}`} className="home-card flex items-center gap-3 !rounded-2xl !px-3 !py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-ink">{jobTitle(order)}</span>
                <span className="mt-0.5 block text-xs text-ink-500">{stageLabel(order.stage)}</span>
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-ink-500/60" strokeWidth={1.75} aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
