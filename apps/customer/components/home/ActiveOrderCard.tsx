"use client";

import type { OrderRow } from "@tuma/shared";
import { MapPin } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { orderTitle, stageLabel, stageProgressPct } from "../../lib/order-display";

export function ActiveOrderCard() {
  const [order, setOrder] = useState<OrderRow | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api
      .getActiveOrder()
      .then((res) => {
        if (!cancelled) setOrder(res.activeOrder);
      })
      .catch(() => {
        if (!cancelled) setOrder(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (order === undefined) return null;
  if (order === null) return null;

  const progress = stageProgressPct(order.stage) / 100;
  // A matched escrow order sitting unpaid needs the customer to act right
  // now — call that out distinctly instead of blending into the generic
  // "Finding rider" progress label, so it's never silently stuck.
  const needsPayment = order.stage === "Match" && order.payment_rail === "escrow" && !!order.rider_id;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-base font-bold text-ink">Active order</h2>
        <Link
          href={`/orders/${order.id}`}
          className="text-sm font-medium text-ink-500 hover:text-ink"
        >
          Track
        </Link>
      </div>

      <Link
        href={`/orders/${order.id}`}
        className="home-card block overflow-hidden !border-l-0 !p-0"
      >
        <div className="flex">
          <span className={`w-1.5 shrink-0 ${needsPayment ? "bg-gold" : "bg-green"}`} aria-hidden />
          <div className="min-w-0 flex-1 space-y-3 px-4 py-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-[15px] font-bold leading-snug text-ink">{orderTitle(order)}</h3>
              <span
                className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  needsPayment ? "bg-gold/15 text-gold" : "bg-green/15 text-green"
                }`}
              >
                {needsPayment ? "Payment needed" : stageLabel(order.stage)}
              </span>
            </div>
            {needsPayment && (
              <p className="text-sm font-medium text-gold">A rider is ready — tap to pay and send your order.</p>
            )}
            <div className="flex items-center gap-3">
              <div
                className="h-2 flex-1 overflow-hidden rounded-full bg-cream"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Order progress"
              >
                <div className="h-full rounded-full bg-green" style={{ width: `${progress * 100}%` }} />
              </div>
              {order.eta_minutes != null && (
                <span className="shrink-0 text-sm font-bold text-green">~{order.eta_minutes} min</span>
              )}
            </div>
            {order.destination_area && (
              <p className="flex items-center gap-1.5 text-sm text-ink-500">
                <MapPin className="h-3.5 w-3.5 shrink-0 text-green" strokeWidth={2.25} aria-hidden />
                <span>Heading to {order.destination_area}</span>
              </p>
            )}
          </div>
        </div>
      </Link>
    </section>
  );
}
