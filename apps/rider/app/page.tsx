"use client";

import type { AvailableJob, OrderRow, Rider } from "@tuma/shared";
import { isRiderProfileComplete } from "@tuma/shared";
import { ChevronRight, MapPin, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { JobPreviewModal } from "../components/JobPreviewModal";
import { api, errorMessage } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { formatUgx, jobTitle, stageLabel } from "../lib/order-display";
import { useLivePolling } from "../lib/use-live-polling";
import { useNetworkStatus } from "../lib/use-network-status";

export default function JobsHomePage() {
  const { user } = useAuth();
  const router = useRouter();
  const [rider, setRider] = useState<Rider | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [availableJobs, setAvailableJobs] = useState<AvailableJob[]>([]);
  const [busy, setBusy] = useState(false);
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewJobItem, setPreviewJobItem] = useState<AvailableJob | null>(null);
  const online = useNetworkStatus();

  const load = useCallback(() => {
    Promise.all([api.myRiderProfile(), api.myRiderOrders(), api.availableJobs()])
      .then(([r, o, j]) => {
        setRider(r.rider);
        setOrders(o.orders);
        setAvailableJobs(j.jobs);
        setLoaded(true);
      })
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useLivePolling(load, 6000, [load]);

  // This screen is the landing page once (and only once) a rider is fully
  // set up: profile complete AND admin-verified. Anyone short of that gets
  // sent to their account screen instead — either to finish the required
  // fields, or to sit and wait for verification — rather than seeing an
  // empty jobs list they can't actually do anything with yet.
  const ready = isRiderProfileComplete(rider) && !!rider?.verified;
  useEffect(() => {
    if (loaded && !ready) router.replace("/account");
  }, [loaded, ready, router]);

  async function toggleOnline() {
    if (!rider) return;
    setBusy(true);
    try {
      const res = await api.setRiderOnline(!rider.is_online);
      setRider(res.rider);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function claimJob(id: string) {
    setClaimingId(id);
    setError(null);
    try {
      await api.claimOrder(id);
      router.push(`/jobs/${id}`);
    } catch (err) {
      setError(errorMessage(err));
      load();
    } finally {
      setClaimingId(null);
    }
  }

  /** "nearest_window"/"customer_selects" jobs don't assign outright — applying just enters the running. */
  async function applyToJob(id: string) {
    setClaimingId(id);
    setError(null);
    try {
      await api.applyForOrder(id);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setClaimingId(null);
    }
  }

  if (!ready) {
    return <div className="p-4 text-sm text-ink-500">Loading…</div>;
  }

  const activeOrders = orders.filter((o) => o.stage !== "Settle");

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-ink">Hi{user?.name ? `, ${user.name}` : ""}</h1>
        <button
          disabled={busy || !online}
          onClick={toggleOnline}
          className={`rounded-full px-4 py-2 text-sm font-bold disabled:opacity-50 ${
            rider?.is_online ? "bg-green text-white" : "bg-[rgb(var(--surface-muted))] text-ink"
          }`}
        >
          {rider?.is_online ? "Online" : "Offline"}
        </button>
      </header>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Available jobs</h2>
        {!rider?.is_online && (
          <p className="py-4 text-center text-sm text-ink-500">Go online to see nearby orders.</p>
        )}
        {rider?.is_online && availableJobs.length === 0 && (
          <p className="py-4 text-center text-sm text-ink-500">No open orders near you right now.</p>
        )}
        <ul className="space-y-2.5">
          {availableJobs.map((job) => (
            <li key={job.id} className="home-card space-y-2.5 !rounded-2xl !px-3 !py-3">
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-bold text-ink">{jobTitle(job)}</span>
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-ink-500">
                    <MapPin className="h-3 w-3 shrink-0" strokeWidth={2} aria-hidden />
                    {job.distanceKm != null ? `${job.distanceKm} km away` : "Distance unknown"}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-sm font-bold text-ink">
                    {formatUgx(job.final_total ?? job.estimated_total)}
                  </span>
                  <span className="block text-xs text-ink-500">
                    {formatUgx(job.delivery_fee ?? job.final_total ?? job.estimated_total)} delivery
                  </span>
                </span>
              </div>
              {job.outOfServiceRange && (
                <div className="flex items-start gap-1.5 rounded-lg bg-gold/10 px-2.5 py-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" strokeWidth={2.25} aria-hidden />
                  <p className="text-xs text-ink-500">
                    Outside the normal service area — you can propose a higher fee once you take it.
                  </p>
                </div>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setPreviewJobItem(job)}
                  className="min-h-10 flex-1 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink"
                >
                  Preview
                </button>
                {job.matching_mode === "first_to_claim" ? (
                  <button
                    onClick={() => claimJob(job.id)}
                    disabled={claimingId === job.id || !online}
                    className="min-h-10 flex-[2] rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
                  >
                    {claimingId === job.id ? "Claiming…" : !online ? "Offline" : "Claim job"}
                  </button>
                ) : (
                  <button
                    onClick={() => applyToJob(job.id)}
                    disabled={claimingId === job.id || job.applied || !online}
                    className={`min-h-10 flex-[2] rounded-full px-4 text-sm font-bold disabled:opacity-60 ${
                      job.applied ? "bg-[rgb(var(--surface-muted))] text-ink-500" : "bg-gold text-ink-gold"
                    }`}
                  >
                    {claimingId === job.id ? "Applying…" : job.applied ? "Applied ✓" : !online ? "Offline" : "Apply"}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Your jobs</h2>
        {activeOrders.length === 0 && (
          <p className="py-6 text-center text-sm text-ink-500">No active jobs yet — claim one above.</p>
        )}
        <ul className="space-y-2.5">
          {activeOrders.map((order) => (
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
      </section>

      {previewJobItem && (
        <JobPreviewModal
          job={previewJobItem}
          busy={claimingId === previewJobItem.id}
          offline={!online}
          onClose={() => setPreviewJobItem(null)}
          onClaim={() => {
            setPreviewJobItem(null);
            claimJob(previewJobItem.id);
          }}
          onApply={() => {
            setPreviewJobItem(null);
            applyToJob(previewJobItem.id);
          }}
        />
      )}
    </div>
  );
}
