"use client";

import type { AvailableJob, ListItem } from "@tuma/shared";
import { MapPin } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { api, errorMessage } from "../lib/api";
import { formatUgx, jobTitle } from "../lib/order-display";

type Props = {
  job: AvailableJob;
  busy: boolean;
  offline?: boolean;
  onClose: () => void;
  onClaim: () => void;
  onApply: () => void;
};

/** Lets a rider see what's actually on the list before deciding to claim or
 * apply — the open-jobs feed itself withholds this (see the API's
 * orders/visibility.ts: toOpenJob) since it goes to every online rider,
 * not just the one about to commit to a job. */
export function JobPreviewModal({ job, busy, offline, onClose, onClaim, onApply }: Props) {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .previewJob(job.id)
      .then((res) => {
        if (!cancelled) setItems(res.items);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [job.id]);

  const itemsTotal = (items ?? []).reduce((sum, it) => sum + (it.unit_price ?? 0) * it.quantity, 0);

  return (
    <Modal title={jobTitle(job)} onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-center gap-1.5 text-sm text-ink-500">
          <MapPin className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
          {job.distanceKm != null ? `${job.distanceKm} km away` : "Distance unknown"}
          {job.destination_area ? ` · ${job.destination_area}` : ""}
        </div>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {job.type === "shopping" ? (
          items === null ? (
            <p className="py-6 text-center text-sm text-ink-500">Loading list…</p>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-500">No items on this list.</p>
          ) : (
            <div className="space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-500">Shopping list</h3>
              <ul className="space-y-1.5">
                {items.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 text-sm text-ink">
                    <span className="min-w-0 flex-1">
                      <span className="block">
                        {item.quantity}× {item.name}
                      </span>
                      {item.note && <span className="block text-xs text-ink-500">{item.note}</span>}
                    </span>
                    {item.unit_price != null && (
                      <span className="shrink-0 font-semibold">{formatUgx(item.unit_price * item.quantity)}</span>
                    )}
                  </li>
                ))}
              </ul>
              {itemsTotal > 0 && (
                <div className="flex justify-between border-t border-[var(--border-faint)] pt-2 text-sm font-semibold text-ink">
                  <span>Estimated items total</span>
                  <span>{formatUgx(itemsTotal)}</span>
                </div>
              )}
            </div>
          )
        ) : (
          <p className="py-6 text-center text-sm text-ink-500">Parcel delivery — no item list for this job.</p>
        )}

        <div className="flex justify-between border-t border-[var(--border-faint)] pt-3 text-sm font-bold text-ink">
          <span>Delivery fee</span>
          <span>{formatUgx(job.delivery_fee ?? job.final_total ?? job.estimated_total)}</span>
        </div>

        {offline && (
          <p className="rounded-lg bg-gold/10 px-3 py-2 text-xs font-semibold text-ink-500">
            You&apos;re offline — reconnect to claim or apply.
          </p>
        )}

        {job.matching_mode === "first_to_claim" ? (
          <button
            onClick={onClaim}
            disabled={busy || offline}
            className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
          >
            {busy ? "Claiming…" : "Claim job"}
          </button>
        ) : (
          <button
            onClick={onApply}
            disabled={busy || job.applied || offline}
            className={`min-h-11 w-full rounded-full px-4 text-sm font-bold disabled:opacity-60 ${
              job.applied ? "bg-[rgb(var(--surface-muted))] text-ink-500" : "bg-gold text-ink-gold"
            }`}
          >
            {busy ? "Applying…" : job.applied ? "Applied ✓" : "Apply"}
          </button>
        )}
      </div>
    </Modal>
  );
}
