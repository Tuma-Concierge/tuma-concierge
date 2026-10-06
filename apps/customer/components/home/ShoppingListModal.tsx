"use client";

import type { SavedLocation } from "@tuma/shared";
import { List, Mic, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LocationPicker, emptyPoint, resolvePoint, type PointState } from "../LocationPicker";
import { Modal } from "../Modal";
import { api, errorMessage } from "../../lib/api";
import { OrderVoiceNoteRecorder } from "./OrderVoiceNoteRecorder";

type Item = { name: string; quantity: string; unitCost: string };
/** "list": type each item with its own cost — today's flow. "voice": speak
 * the list instead (for anyone who reads numbers more easily than text) and
 * just key in the total, which is what escrow actually needs. */
type Mode = "list" | "voice";

function currency(n: number) {
  return `UGX ${n.toLocaleString("en-UG")}`;
}

export function ShoppingListModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<"items" | "location">("items");
  const [mode, setMode] = useState<Mode>("list");
  const [items, setItems] = useState<Item[]>([{ name: "", quantity: "1", unitCost: "" }]);
  const [voiceTotal, setVoiceTotal] = useState("");

  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [delivery, setDelivery] = useState<PointState>(emptyPoint);
  const [paymentRail, setPaymentRail] = useState<"escrow" | "float">("escrow");
  const [voiceNote, setVoiceNote] = useState<Blob | null>(null);
  const [deliveryFee, setDeliveryFee] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getLocations()
      .then((res) => setLocations(res.locations))
      .catch(() => {});
    api
      .getSettings()
      .then((res) => setDeliveryFee(res.settings.shoppingDeliveryFee))
      .catch(() => {});
  }, []);

  const listTotal = items.reduce((sum, it) => sum + (Number(it.quantity) || 0) * (Number(it.unitCost) || 0), 0);
  const itemsTotal = mode === "voice" ? Number(voiceTotal) || 0 : listTotal;
  const total = itemsTotal + deliveryFee;

  function updateItem(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, { name: "", quantity: "1", unitCost: "" }]);
  }
  function removeItem(i: number) {
    setItems((prev) => prev.filter((_, idx) => idx !== i));
  }

  function goToLocation() {
    if (mode === "list") {
      const clean = items.filter((it) => it.name.trim().length > 0);
      if (clean.length === 0) {
        setError("Add at least one item.");
        return;
      }
    } else {
      if (!voiceNote) {
        setError("Record a voice note describing what you need.");
        return;
      }
      if (!voiceTotal || Number(voiceTotal) <= 0) {
        setError("Enter the total amount.");
        return;
      }
    }
    setError(null);
    setStep("location");
  }

  async function submit() {
    const d = resolvePoint(delivery, locations);
    if (!d.area && !d.address) {
      setError("Choose a delivery location.");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const cleanItems = items
        .filter((it) => it.name.trim())
        .map((it) => ({
          name: it.name.trim(),
          quantity: Math.max(1, Number(it.quantity) || 1),
          unitCost: Number(it.unitCost) || 0,
        }));
      const list = await api.createList({
        items: cleanItems.map((it) => ({ name: it.name, quantity: it.quantity, unitCost: it.unitCost })),
      });
      const { order } = await api.createOrder({
        listId: list.listId,
        type: "shopping",
        destinationArea: d.area,
        destinationAddress: d.address,
        destinationLat: d.lat,
        destinationLng: d.lng,
        paymentRail,
        // The delivery fee is added server-side (see the API's shoppingDeliveryFee) —
        // this is just the items estimate, not itemsTotal + deliveryFee.
        estimatedTotal: itemsTotal || undefined,
      });
      if (voiceNote) {
        api.uploadOrderVoiceNote(order.id, voiceNote).catch(() => {});
      }
      onClose();
      router.push(`/orders/${order.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={step === "items" ? "Shopping List" : "Delivery location"} onClose={onClose}>
      {step === "items" ? (
        <div className="space-y-4">
          <div className="flex rounded-full bg-[rgb(var(--surface-muted))] p-1">
            {(["list", "voice"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2.5 text-sm font-bold transition-colors ${
                  mode === m ? "bg-gold text-ink-gold shadow-sm" : "text-ink-500"
                }`}
              >
                {m === "list" ? (
                  <List className="h-4 w-4" strokeWidth={2} aria-hidden />
                ) : (
                  <Mic className="h-4 w-4" strokeWidth={2} aria-hidden />
                )}
                {m === "list" ? "Write list" : "Voice note"}
              </button>
            ))}
          </div>

          {mode === "list" ? (
            <div className="space-y-2">
              {items.map((item, i) => (
                <div key={i} className="flex items-center gap-2 rounded-xl border border-[var(--border-faint)] bg-[rgb(var(--surface-card))] p-2.5">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--surface-muted))] text-xs font-bold text-ink-500">
                    {i + 1}
                  </span>
                  <input
                    value={item.name}
                    onChange={(e) => updateItem(i, { name: e.target.value })}
                    placeholder="Item name"
                    className="min-w-0 flex-1 border-none bg-transparent text-sm outline-none"
                  />
                  <input
                    value={item.quantity}
                    onChange={(e) => updateItem(i, { quantity: e.target.value.replace(/[^\d]/g, "") })}
                    inputMode="numeric"
                    placeholder="Qty"
                    className="w-12 shrink-0 rounded-lg border border-[var(--border-faint)] bg-transparent px-1.5 py-1 text-center text-sm text-ink outline-none"
                  />
                  <input
                    value={item.unitCost}
                    onChange={(e) => updateItem(i, { unitCost: e.target.value.replace(/[^\d]/g, "") })}
                    inputMode="numeric"
                    placeholder="Unit cost"
                    className="w-20 shrink-0 rounded-lg border border-[var(--border-faint)] bg-transparent px-1.5 py-1 text-right text-sm text-ink outline-none"
                  />
                  <button
                    onClick={() => removeItem(i)}
                    className="flex h-6 w-6 shrink-0 items-center justify-center text-ink-500/60 hover:text-red-600"
                    aria-label="Remove item"
                  >
                    <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              ))}
              <button
                onClick={addItem}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-[var(--border-faint)] py-2.5 text-sm font-semibold text-ink-500"
              >
                <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                Add item
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs text-ink-500">
                Record what you need — your rider will listen to it. Then enter the total so we know how much to
                charge.
              </p>
              <OrderVoiceNoteRecorder blob={voiceNote} onChange={setVoiceNote} />
              <div className="space-y-1">
                <label className="text-xs font-semibold text-ink-500" htmlFor="voice-total">
                  Total amount (UGX)
                </label>
                <input
                  id="voice-total"
                  inputMode="numeric"
                  value={voiceTotal}
                  onChange={(e) => setVoiceTotal(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="e.g. 25000"
                  className="w-full rounded-xl border border-[var(--border-faint)] bg-[rgb(var(--surface-card))] px-3 py-3 text-lg font-bold text-ink outline-none focus:border-gold"
                />
              </div>
            </div>
          )}

          <div className="space-y-1.5 rounded-xl bg-[rgb(var(--surface-muted))] px-4 py-3">
            <div className="flex items-center justify-between text-sm text-ink-500">
              <span>Items total</span>
              <span>{currency(itemsTotal)}</span>
            </div>
            <div className="flex items-center justify-between text-sm text-ink-500">
              <span>Delivery fee</span>
              <span>{currency(deliveryFee)}</span>
            </div>
            <div className="flex items-center justify-between border-t border-[var(--border-faint)] pt-1.5">
              <span className="text-sm font-semibold text-ink">You&apos;ll pay</span>
              <span className="text-base font-bold text-ink">{currency(total)}</span>
            </div>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <button
            onClick={goToLocation}
            className="min-h-12 w-full rounded-full bg-gold px-4 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)]"
          >
            Next: delivery location
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <LocationPicker point={delivery} setPoint={setDelivery} locations={locations} />

          {/* Voice mode already recorded the list itself as this same voice note — asking again here would be redundant. */}
          {mode === "list" && <OrderVoiceNoteRecorder blob={voiceNote} onChange={setVoiceNote} />}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Payment</p>
            <div className="flex gap-2">
              {(["escrow", "float"] as const).map((rail) => (
                <button
                  key={rail}
                  onClick={() => setPaymentRail(rail)}
                  className={`flex-1 rounded-xl border px-3 py-2.5 text-sm font-semibold capitalize ${
                    paymentRail === rail ? "border-gold bg-gold/10 text-ink" : "border-[var(--border-faint)] text-ink-500"
                  }`}
                >
                  {rail === "float" ? "Cash" : "Escrow"}
                </button>
              ))}
            </div>
            <p className="text-xs text-ink-500">
              {paymentRail === "float"
                ? "You pay the rider directly, in person."
                : "You pay upfront — held safely until delivery is confirmed."}
            </p>
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={() => setStep("items")}
              className="min-h-12 flex-1 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink"
            >
              Back
            </button>
            <button
              onClick={submit}
              disabled={busy}
              className="min-h-12 flex-[2] rounded-full bg-gold px-4 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-60"
            >
              {busy ? "Sending…" : "Send list"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
