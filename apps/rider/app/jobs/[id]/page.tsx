"use client";

import type { OrderDetail } from "@tuma/shared";
import { MapPin, MessageCircle, Pencil, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { CustomerAvatar } from "../../../components/CustomerAvatar";
import { DeliveryNavigation } from "../../../components/DeliveryNavigation";
import { FeeProposalVoicePlayer } from "../../../components/FeeProposalVoicePlayer";
import { VoiceNotePlayer } from "../../../components/VoiceNotePlayer";
import { VoiceReasonRecorder } from "../../../components/VoiceReasonRecorder";
import { api, errorMessage } from "../../../lib/api";
import { formatUgx, jobTitle, stageLabel } from "../../../lib/order-display";
import { useLivePolling } from "../../../lib/use-live-polling";

type PendingEdit = { originalName: string; substituteName: string; priceDelta: number };

export default function JobDetailPage() {
  const params = useParams<{ id: string }>();
  const orderId = params.id;
  const router = useRouter();
  const [detail, setDetail] = useState<OrderDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [etaMinutes, setEtaMinutes] = useState("15");
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [draftSubstitute, setDraftSubstitute] = useState("");
  const [draftPriceDelta, setDraftPriceDelta] = useState("0");
  const [pendingEdits, setPendingEdits] = useState<Record<string, PendingEdit>>({});
  const [showFeeForm, setShowFeeForm] = useState(false);
  const [feeDraft, setFeeDraft] = useState("");
  const [feeReason, setFeeReason] = useState("");
  const [feeVoiceNote, setFeeVoiceNote] = useState<Blob | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);

  const load = useCallback(async () => {
    const res = await api.getOrder(orderId);
    setDetail(res);
    return res;
  }, [orderId]);

  useLivePolling(() => void load().catch(() => {}), 4000, [load]);

  useEffect(() => {
    if (detail?.order.stage !== "Settle") return;
    api
      .myWallet()
      .then((w) => setWalletBalance(w.balance))
      .catch(() => {});
  }, [detail?.order.stage]);

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

  if (!detail) {
    return <div className="p-4 text-sm text-ink-500">Loading job…</div>;
  }

  const { order, items, substitutions, feeProposals } = detail;
  const canDeliver = ["Shop", "Substitute", "Approve"].includes(order.stage);
  const canPropose = order.type === "shopping" && (order.stage === "Shop" || order.stage === "Substitute");
  const canProposeFee = !["Create", "Settle"].includes(order.stage);
  const canCancel = ["Match", "Fund", "Shop", "Substitute", "Approve", "Deliver"].includes(order.stage);
  const latestFeeProposal = feeProposals[feeProposals.length - 1];
  const currentItemsTotal = (order.final_total ?? order.estimated_total ?? 0) - (order.delivery_fee ?? 0);
  const pendingCount = Object.keys(pendingEdits).length;
  const pendingNetDelta = Object.values(pendingEdits).reduce((sum, e) => sum + e.priceDelta, 0);

  function markUnavailable(item: OrderDetail["items"][number]) {
    setPendingEdits((prev) => ({
      ...prev,
      [item.id]: {
        originalName: item.name,
        substituteName: "Not available",
        priceDelta: item.unit_price != null ? -(item.unit_price * item.quantity) : 0,
      },
    }));
    setEditingItemId(null);
  }

  function saveDraft(item: OrderDetail["items"][number]) {
    setPendingEdits((prev) => ({
      ...prev,
      [item.id]: {
        originalName: item.name,
        substituteName: draftSubstitute.trim() || "Not available",
        priceDelta: Number(draftPriceDelta) || 0,
      },
    }));
    setEditingItemId(null);
  }

  function removeEdit(itemId: string) {
    setPendingEdits((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
  }

  async function sendBatch() {
    setBusy(true);
    setError(null);
    try {
      await api.proposeSubstitutionBatch(orderId, Object.values(pendingEdits));
      setPendingEdits({});
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function sendFeeProposal() {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      // feeDraft is the new DELIVERY FEE only — not the grand total. The
      // items cost is fixed by what's on the list; a rider proposing a fee
      // change (typically for an out-of-range match) is adjusting their own
      // delivery pay, not re-quoting groceries they haven't bought yet.
      const currentTotal = detail.order.final_total ?? detail.order.estimated_total ?? 0;
      const itemsTotal = currentTotal - (detail.order.delivery_fee ?? 0);
      const proposedTotal = itemsTotal + (Number(feeDraft) || 0);
      const res = await api.proposeFee(orderId, {
        proposedTotal,
        reason: feeReason.trim() || undefined,
      });
      if (feeVoiceNote) {
        await api.uploadFeeProposalVoiceNote(orderId, res.proposalId, feeVoiceNote);
      }
      setShowFeeForm(false);
      setFeeDraft("");
      setFeeReason("");
      setFeeVoiceNote(null);
      await load();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelOrder(orderId);
      router.push("/");
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 px-4 pb-24 pt-4">
      <header className="space-y-1">
        <div className="flex items-center gap-3">
          {order.customer_id && <CustomerAvatar customerId={order.customer_id} />}
          <h1 className="text-xl font-bold text-ink">{jobTitle(order)}</h1>
        </div>
        <p className="text-sm font-semibold text-green">{stageLabel(order.stage, order.type)}</p>
        {order.type === "parcel" && order.pickup_area && (
          <p className="flex items-center gap-1.5 text-sm text-ink-500">
            <MapPin className="h-3.5 w-3.5 text-ink-500" strokeWidth={2} aria-hidden />
            Pickup: {order.pickup_area}
            {order.pickup_address ? ` · ${order.pickup_address}` : ""}
          </p>
        )}
        {order.destination_area && (
          <p className="flex items-center gap-1.5 text-sm text-ink-500">
            <MapPin className="h-3.5 w-3.5 text-ink-500" strokeWidth={2} aria-hidden />
            {order.type === "parcel" ? "Deliver to: " : ""}
            {order.destination_area}
            {order.destination_address ? ` · ${order.destination_address}` : ""}
          </p>
        )}
      </header>

      {order.voice_note_key && <VoiceNotePlayer orderId={orderId} />}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {order.type === "shopping" ? (
        <section className="home-card space-y-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Shopping list</h2>
          <ul className="space-y-1.5">
            {items.map((item) => {
              const edit = pendingEdits[item.id];
              const isEditing = editingItemId === item.id;
              return (
                <li key={item.id} className="rounded-xl border border-transparent py-0.5">
                  <div className="flex items-center justify-between text-sm text-ink">
                    <span className="min-w-0 flex-1">
                      <span className={`block ${edit ? "text-ink-500 line-through" : ""}`}>
                        {item.quantity}× {item.name}
                        {item.unit_price != null && (
                          <span className="text-ink-500"> · Est. {formatUgx(item.unit_price)} each</span>
                        )}
                      </span>
                      {item.note && <span className="block text-xs text-ink-500">{item.note}</span>}
                      {edit && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs font-semibold text-gold">
                          → {edit.substituteName}
                          {edit.priceDelta !== 0 &&
                            ` (${edit.priceDelta > 0 ? "+" : ""}${formatUgx(edit.priceDelta)})`}
                          <button
                            type="button"
                            onClick={() => removeEdit(item.id)}
                            className="text-ink-500 underline"
                          >
                            Undo
                          </button>
                        </span>
                      )}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {item.unit_price != null && !edit && (
                        <span className="font-semibold">{formatUgx(item.unit_price * item.quantity)}</span>
                      )}
                      {canPropose && !edit && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingItemId(isEditing ? null : item.id);
                            setDraftSubstitute("");
                            setDraftPriceDelta("0");
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-full text-ink-500/60 hover:text-ink"
                          aria-label={`Edit ${item.name}`}
                        >
                          {isEditing ? <X className="h-3.5 w-3.5" strokeWidth={2} /> : <Pencil className="h-3.5 w-3.5" strokeWidth={2} />}
                        </button>
                      )}
                    </span>
                  </div>
                  {isEditing && (
                    <div className="mt-1.5 space-y-1.5 rounded-xl bg-[rgb(var(--surface-muted))] p-2.5">
                      <button
                        type="button"
                        onClick={() => markUnavailable(item)}
                        className="w-full rounded-lg bg-[rgb(var(--surface-card))] py-1.5 text-xs font-bold text-ink"
                      >
                        Not available — remove from list
                      </button>
                      <div className="grid grid-cols-2 gap-1.5">
                        <input
                          value={draftSubstitute}
                          onChange={(e) => setDraftSubstitute(e.target.value)}
                          placeholder="Replace with…"
                          className="w-full rounded-lg border border-[var(--border-faint)] px-2 py-1.5 text-xs outline-none focus:border-gold"
                        />
                        <input
                          value={draftPriceDelta}
                          onChange={(e) => setDraftPriceDelta(e.target.value.replace(/[^-\d]/g, ""))}
                          inputMode="numeric"
                          placeholder="Price change"
                          className="w-full rounded-lg border border-[var(--border-faint)] px-2 py-1.5 text-xs outline-none focus:border-gold"
                        />
                      </div>
                      <button
                        type="button"
                        disabled={!draftSubstitute.trim()}
                        onClick={() => saveDraft(item)}
                        className="w-full rounded-lg bg-gold py-1.5 text-xs font-bold text-ink-gold disabled:opacity-50"
                      >
                        Save change
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="space-y-1 border-t border-[var(--border-faint)] pt-2 text-sm font-semibold">
            <div className="flex justify-between">
              <span>Items total</span>
              <span>{formatUgx((order.final_total ?? order.estimated_total ?? 0) - (order.delivery_fee ?? 0))}</span>
            </div>
            <div className="flex justify-between text-ink-500">
              <span>Delivery fee</span>
              <span>{formatUgx(order.delivery_fee ?? 0)}</span>
            </div>
          </div>
          {pendingCount > 0 && (
            <div className="flex items-center justify-between gap-3 rounded-xl border border-gold bg-gold/10 p-3">
              <p className="text-xs font-semibold text-ink">
                {pendingCount} change{pendingCount > 1 ? "s" : ""} ·{" "}
                {pendingNetDelta >= 0 ? "+" : ""}
                {formatUgx(pendingNetDelta)}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={sendBatch}
                className="shrink-0 rounded-full bg-gold px-4 py-2 text-xs font-bold text-ink-gold disabled:opacity-60"
              >
                Send for approval
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="home-card flex justify-between text-sm font-semibold">
          <span>Delivery fee</span>
          <span>{formatUgx(order.delivery_fee ?? order.final_total ?? order.estimated_total)}</span>
        </section>
      )}

      {canProposeFee && (
        <section className="home-card space-y-2">
          <h2 className="text-sm font-semibold text-ink">Delivery fee</h2>
          {latestFeeProposal && (
            <div className="rounded-xl bg-[rgb(var(--surface-muted))] p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink">
                  You suggested a delivery fee of {formatUgx(latestFeeProposal.proposed_total - currentItemsTotal)}
                  {latestFeeProposal.reason ? ` — ${latestFeeProposal.reason}` : ""}
                </span>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                    latestFeeProposal.status === "approved"
                      ? "bg-green/15 text-green"
                      : latestFeeProposal.status === "rejected"
                        ? "bg-red-100 text-red-700"
                        : "bg-white text-ink-500"
                  }`}
                >
                  {latestFeeProposal.status === "pending" ? "Waiting" : latestFeeProposal.status}
                </span>
              </div>
              {latestFeeProposal.reason_voice_key && (
                <FeeProposalVoicePlayer orderId={orderId} proposalId={latestFeeProposal.id} />
              )}
            </div>
          )}
          {!showFeeForm ? (
            (!latestFeeProposal || latestFeeProposal.status !== "pending") && (
              <button
                type="button"
                onClick={() => {
                  setShowFeeForm(true);
                  setFeeDraft(String(order.delivery_fee ?? ""));
                }}
                className="text-sm font-bold text-gold"
              >
                Suggest a different delivery fee
              </button>
            )
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-ink-500" htmlFor="new-delivery-fee">
                  New delivery fee (UGX) — items cost isn&apos;t affected
                </label>
                <input
                  id="new-delivery-fee"
                  value={feeDraft}
                  onChange={(e) => setFeeDraft(e.target.value.replace(/[^\d]/g, ""))}
                  inputMode="numeric"
                  placeholder="e.g. 8000"
                  className="w-full rounded-lg border-2 border-gold/40 px-2.5 py-2.5 text-base font-bold text-ink outline-none focus:border-gold"
                />
                <p className="text-xs text-ink-500">Currently {formatUgx(order.delivery_fee ?? 0)}.</p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-semibold text-ink-500" htmlFor="fee-reason">
                  Reason (optional, typed)
                </label>
                <input
                  id="fee-reason"
                  value={feeReason}
                  onChange={(e) => setFeeReason(e.target.value)}
                  placeholder="Type a reason in English…"
                  className="w-full rounded-lg border border-[var(--border-faint)] px-2.5 py-2 text-sm outline-none focus:border-gold"
                />
              </div>

              <div className="space-y-1 rounded-lg border border-dashed border-[var(--border-faint)] p-2.5">
                <p className="text-xs font-semibold text-ink-500">Or record a voice reason (any language)</p>
                <VoiceReasonRecorder blob={feeVoiceNote} onChange={setFeeVoiceNote} />
              </div>

              <div className="flex gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setShowFeeForm(false);
                    setFeeVoiceNote(null);
                  }}
                  className="flex-1 rounded-lg border border-[var(--border-faint)] py-1.5 text-xs font-bold text-ink"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy || !feeDraft}
                  onClick={sendFeeProposal}
                  className="flex-[2] rounded-lg bg-gold py-1.5 text-xs font-bold text-ink-gold disabled:opacity-50"
                >
                  Send to customer
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="home-card space-y-3">
        {["Create", "Match", "Fund"].includes(order.stage) && (
          <p className="text-sm text-ink-500">Waiting on the customer to fund this order.</p>
        )}

        {canPropose && pendingCount === 0 && (
          <p className="text-sm text-ink-500">
            Tap the pencil next to an item above if something&apos;s unavailable or costs more.
          </p>
        )}

        {substitutions.length > 0 && (
          <ul className="space-y-1.5">
            {substitutions.map((sub) => (
              <li key={sub.id} className="flex items-center justify-between text-sm">
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
              </li>
            ))}
          </ul>
        )}

        {canDeliver && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => api.deliverOrder(orderId, Number(etaMinutes) || undefined));
            }}
            className="flex items-center gap-2 border-t border-[var(--border-faint)] pt-3"
          >
            <input
              value={etaMinutes}
              onChange={(e) => setEtaMinutes(e.target.value.replace(/[^\d]/g, ""))}
              inputMode="numeric"
              placeholder="ETA (min)"
              className="w-24 rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-sm outline-none focus:border-gold"
            />
            <button
              type="submit"
              disabled={busy}
              className="min-h-11 flex-1 rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
            >
              Start delivery
            </button>
          </form>
        )}

        {order.stage === "Deliver" && (
          <>
            <p className="text-sm text-ink-500">
              On the way{order.eta_minutes ? ` — ~${order.eta_minutes} min` : ""}. Navigate to the customer, then
              confirm once you&apos;ve arrived.
            </p>
            <DeliveryNavigation
              orderId={orderId}
              destinationLat={order.destination_lat}
              destinationLng={order.destination_lng}
              busy={busy}
              onConfirmDelivery={() =>
                run(async () => {
                  await api.arrivedOrder(orderId);
                  router.push("/active");
                })
              }
            />
          </>
        )}

        {order.stage === "Arrived" && (
          <p className="text-sm text-ink-500">
            The customer&apos;s been notified you&apos;re here. Ask them to confirm handover in their app.
          </p>
        )}

        {order.stage === "Handover" && (
          <>
            <p className="text-sm text-ink-500">Handover confirmed. Collect your payout.</p>
            <button
              disabled={busy}
              onClick={() => run(() => api.settleOrder(orderId))}
              className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
            >
              Settle & get paid
            </button>
          </>
        )}

        {order.stage === "Settle" && (
          <div className="space-y-3 text-center">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">You earned</p>
              <p className="text-3xl font-extrabold text-green">
                {formatUgx(order.delivery_fee ?? order.final_total ?? order.estimated_total)}
              </p>
              {order.type === "shopping" && order.payment_rail === "escrow" && order.delivery_fee != null && (
                <p className="mt-1 text-xs text-ink-500">
                  Plus{" "}
                  {formatUgx((order.final_total ?? order.estimated_total ?? 0) - order.delivery_fee)} reimbursed
                  for items — {formatUgx(order.final_total ?? order.estimated_total)} total settled to your
                  wallet.
                </p>
              )}
            </div>
            {walletBalance != null && (
              <p className="text-sm text-ink-500">
                Wallet balance: <span className="text-base font-bold text-ink">{formatUgx(walletBalance)}</span>
              </p>
            )}
            <Link
              href="/"
              className="inline-flex min-h-11 w-full items-center justify-center rounded-full bg-gold px-6 text-sm font-bold text-ink-gold"
            >
              Back to Jobs
            </Link>
          </div>
        )}
      </section>

      {canCancel && (
        <section className="home-card space-y-2">
          {!confirmCancel ? (
            <button
              type="button"
              onClick={() => setConfirmCancel(true)}
              className="w-full text-center text-sm font-bold text-red-600"
            >
              Cancel this job
            </button>
          ) : (
            <div className="space-y-2 text-center">
              <p className="text-sm text-ink-500">
                This job goes back to the pool for another rider. You won&apos;t be offered it again.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmCancel(false)}
                  className="flex-1 rounded-full border border-[var(--border-faint)] py-2 text-sm font-bold text-ink"
                >
                  Keep job
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={cancelJob}
                  className="flex-1 rounded-full bg-red-600 py-2 text-sm font-bold text-white disabled:opacity-60"
                >
                  Yes, cancel
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {order.customer_id && (
        <Link
          href={`/chat/${order.customer_id}`}
          className="home-card flex items-center gap-2 !rounded-2xl !py-3 text-sm font-bold text-ink"
        >
          <MessageCircle className="h-4 w-4 text-gold" strokeWidth={2} aria-hidden />
          Open full-screen chat
        </Link>
      )}
    </div>
  );
}
