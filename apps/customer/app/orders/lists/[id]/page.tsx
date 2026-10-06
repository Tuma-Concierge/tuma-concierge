"use client";

import type { ListDetail } from "@tuma/shared";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../../../lib/api";
import { formatUgx } from "../../../../lib/order-display";

export default function ListDetailPage() {
  const params = useParams<{ id: string }>();
  const listId = params.id;
  const [detail, setDetail] = useState<ListDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getList(listId)
      .then(setDetail)
      .catch((err) => setError(errorMessage(err)));
  }, [listId]);

  if (error) {
    return <p className="p-4 text-sm text-red-700">{error}</p>;
  }
  if (!detail) {
    return <div className="p-4 text-sm text-ink-500">Loading list…</div>;
  }

  const { list, items } = detail;
  const hasPricing = items.some((it) => it.unit_price != null);
  const total = items.reduce((sum, it) => sum + (it.unit_price ?? 0) * it.quantity, 0);

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-ink">{list.title}</h1>
        <p className="text-sm font-semibold capitalize text-green">{list.status}</p>
      </header>

      <section className="home-card space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Items as sent</h2>
        {items.length === 0 && <p className="text-sm text-ink-500">No items on this list.</p>}
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id} className="flex items-start justify-between gap-3 text-sm text-ink">
              <span className="min-w-0">
                <span className="block font-medium">
                  {item.quantity}× {item.name}
                </span>
                {item.unit_price != null && (
                  <span className="block text-xs text-ink-500">Est. {formatUgx(item.unit_price)} each</span>
                )}
                {item.note && <span className="block text-xs text-ink-500">{item.note}</span>}
              </span>
              {item.unit_price != null && (
                <span className="shrink-0 font-semibold">{formatUgx(item.unit_price * item.quantity)}</span>
              )}
            </li>
          ))}
        </ul>
        {hasPricing && (
          <div className="flex justify-between border-t border-[var(--border-faint)] pt-2 text-sm font-semibold">
            <span>Estimated total</span>
            <span>{formatUgx(total)}</span>
          </div>
        )}
      </section>
    </div>
  );
}
