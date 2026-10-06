"use client";

import { Download, Navigation, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "./Modal";
import { mapsStoreUrl, openMapsNavigation } from "../lib/navigation";

function storageKey(orderId: string) {
  return `tuma-nav-started-${orderId}`;
}

/** The "on the way" stage's navigation + delivery-confirmation flow.
 *
 * "Started navigation" is persisted per order so the UI stays on the
 * Resume/Confirm step rather than resetting back to "Start Navigation"
 * if the rider's browser tab gets reloaded or killed in the background
 * while Google Maps has focus — a real risk on low-memory Android phones. */
export function DeliveryNavigation({
  orderId,
  destinationLat,
  destinationLng,
  busy,
  onConfirmDelivery,
}: {
  orderId: string;
  destinationLat: number | null;
  destinationLng: number | null;
  busy: boolean;
  onConfirmDelivery: () => void;
}) {
  const [navStarted, setNavStarted] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [showInstallPrompt, setShowInstallPrompt] = useState(false);
  const hasDestination = destinationLat != null && destinationLng != null;
  const storeUrl = mapsStoreUrl();

  useEffect(() => {
    try {
      setNavStarted(localStorage.getItem(storageKey(orderId)) === "1");
    } catch {}
  }, [orderId]);

  function startNavigation() {
    if (!hasDestination) return;
    openMapsNavigation(destinationLat as number, destinationLng as number, () => {
      if (storeUrl) setShowInstallPrompt(true);
    });
    setNavStarted(true);
    try {
      localStorage.setItem(storageKey(orderId), "1");
    } catch {}
  }

  function confirmDelivery() {
    setConfirming(false);
    try {
      localStorage.removeItem(storageKey(orderId));
    } catch {}
    onConfirmDelivery();
  }

  return (
    <div className="space-y-2 border-t border-[var(--border-faint)] pt-3">
      {!navStarted ? (
        <button
          type="button"
          onClick={startNavigation}
          disabled={!hasDestination}
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-gold px-4 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-60"
        >
          <Navigation className="h-5 w-5" strokeWidth={2.25} aria-hidden />
          Start Navigation
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy}
            className="min-h-12 w-full rounded-full bg-gold px-4 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-60"
          >
            Confirm Delivery
          </button>
          <button type="button" onClick={startNavigation} className="w-full text-center text-sm font-bold text-gold">
            Resume Navigation
          </button>
        </>
      )}

      {showInstallPrompt && storeUrl && (
        <div className="flex items-start gap-2.5 rounded-xl border border-[var(--border-faint)] bg-[rgb(var(--surface-muted))] p-3">
          <Download className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={2.25} aria-hidden />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-xs text-ink-500">
              Opened directions in your browser — install Google Maps for faster, turn-by-turn navigation next time.
            </p>
            <a
              href={storeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs font-bold text-gold underline"
            >
              Get Google Maps
            </a>
          </div>
          <button
            type="button"
            onClick={() => setShowInstallPrompt(false)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-500/60"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      {confirming && (
        <Modal title="Confirm delivery" onClose={() => setConfirming(false)}>
          <div className="space-y-4">
            <p className="text-sm text-ink-500">
              Confirms you&apos;ve reached the customer and marks this job as arrived. They&apos;ll be notified to
              confirm handover on their end.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="flex-1 rounded-full border border-[var(--border-faint)] py-2.5 text-sm font-bold text-ink"
              >
                Not yet
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirmDelivery}
                className="flex-[2] rounded-full bg-gold py-2.5 text-sm font-bold text-ink-gold disabled:opacity-60"
              >
                Yes, confirm delivery
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
