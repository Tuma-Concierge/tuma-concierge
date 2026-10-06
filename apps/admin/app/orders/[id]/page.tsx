"use client";

import type { OrderDetail } from "@tuma/shared";
import { ArrowLeft, MapPin } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../../lib/api";
import { formatDate, formatUgx, orderTitle, stageLabel } from "../../../lib/order-display";

export default function AdminOrderDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api.getOrder(orderId);
    setDetail(res);
  }, [orderId]);

  useEffect(() => {
    load().catch((err) => setError(errorMessage(err)));
    const interval = setInterval(() => load().catch(() => {}), 8000);
    return () => clearInterval(interval);
  }, [load]);

  if (!detail) {
    return <div className="p-4 text-sm text-ink-500">{error ?? "Loading order…"}</div>;
  }

  const { order, items, events, substitutions, payments } = detail;

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <Link href="/orders" className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink-500">
        <ArrowLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
        Orders
      </Link>

      <header className="space-y-1">
        <h1 className="text-xl font-bold text-ink">{orderTitle(order)}</h1>
        <p className="text-sm font-semibold text-green">{stageLabel(order.stage, order.type)}</p>
        {order.type === "parcel" && order.pickup_area && (
          <p className="flex items-center gap-1.5 text-sm text-ink-500">
            <MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Pickup: {order.pickup_area}
            {order.pickup_address ? ` · ${order.pickup_address}` : ""}
          </p>
        )}
        {order.destination_area && (
          <p className="flex items-center gap-1.5 text-sm text-ink-500">
            <MapPin className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {order.destination_area}
            {order.destination_address ? ` · ${order.destination_address}` : ""}
          </p>
        )}
      </header>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {order.type === "shopping" && items.length > 0 && (
        <section className="home-card space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Items</h2>
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item.id} className="flex items-center justify-between text-sm text-ink">
                <span>
                  {item.quantity}× {item.name}
                </span>
                {item.note && <span className="text-xs text-ink-500">{item.note}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="home-card flex justify-between text-sm font-semibold">
        <span>Total</span>
        <span>{formatUgx(order.final_total ?? order.estimated_total)}</span>
      </section>

      {substitutions.length > 0 && (
        <section className="home-card space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Substitutions</h2>
          {substitutions.map((sub) => (
            <div key={sub.id} className="flex items-center justify-between text-sm">
              <span className="text-ink">
                {sub.original_name} → {sub.substitute_name}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                  sub.status === "approved"
                    ? "bg-green/15 text-green"
                    : sub.status === "rejected"
                      ? "bg-red-100 text-red-700"
                      : "bg-[rgb(var(--surface-muted))] text-ink-500"
                }`}
              >
                {sub.status}
              </span>
            </div>
          ))}
        </section>
      )}

      {payments.length > 0 && (
        <section className="home-card space-y-1.5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Payments</h2>
          {payments.map((p) => (
            <div key={p.id} className="flex items-center justify-between text-sm">
              <span className="text-ink capitalize">{p.type}</span>
              <span className="text-ink-500">{formatUgx(p.amount)}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                  p.status === "successful"
                    ? "bg-green/15 text-green"
                    : p.status === "failed"
                      ? "bg-red-100 text-red-700"
                      : "bg-[rgb(var(--surface-muted))] text-ink-500"
                }`}
              >
                {p.status}
              </span>
            </div>
          ))}
        </section>
      )}

      <section className="home-card space-y-1.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">History</h2>
        <ul className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="text-sm">
              <span className="font-semibold text-ink">{event.stage}</span>
              <span className="text-ink-500"> — {event.note}</span>
              <div className="text-xs text-ink-500">{formatDate(event.created_at)}</div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
