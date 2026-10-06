"use client";

import { Briefcase, ChevronRight, Home, Keyboard, LocateFixed, Map, MoreHorizontal } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";
import { Modal } from "./Modal";
import { api, errorMessage } from "../lib/api";

const LocationMapPicker = dynamic(() => import("./LocationMapPicker").then((m) => m.LocationMapPicker), { ssr: false });

type LocationKind = "Home" | "Office" | "Other";
type Step = "menu" | "manual";

const KIND_OPTIONS: { key: LocationKind; icon: typeof Home }[] = [
  { key: "Home", icon: Home },
  { key: "Office", icon: Briefcase },
  { key: "Other", icon: MoreHorizontal },
];

export function SaveLocationPrompt({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<LocationKind>("Home");
  const [otherName, setOtherName] = useState("");
  const [step, setStep] = useState<Step>("menu");
  const [showPicker, setShowPicker] = useState(false);
  const [manualArea, setManualArea] = useState("");
  const [manualAddress, setManualAddress] = useState("");
  const [locating, setLocating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function persist(input: { area?: string; address?: string; lat?: number; lng?: number }) {
    if (kind === "Other" && !otherName.trim()) {
      setError("Give this location a name.");
      return;
    }
    if (!input.area && !input.address) {
      setError("Couldn't find that location — try another option.");
      return;
    }
    setBusy(true);
    setError(null);
    const label = kind === "Other" ? otherName.trim() : kind;
    try {
      await api.saveLocation({ label, area: input.area, address: input.address, lat: input.lat, lng: input.lng });
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  const needsName = kind === "Other" && !otherName.trim();

  function useCurrentLocation() {
    if (needsName) {
      setError("Give this location a name.");
      return;
    }
    setError(null);
    setLocating(true);
    if (!navigator.geolocation) {
      setLocating(false);
      setError("Your browser can't share your location — try another option.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setLocating(false);
        await persist({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          address: `Current location (${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)})`,
        });
      },
      () => {
        setLocating(false);
        setError("Couldn't get your location — try another option.");
      },
      { timeout: 10000 },
    );
  }

  return (
    <Modal title="Save a location" onClose={onClose}>
      <div className="space-y-4">
        <p className="-mt-2 text-sm text-ink-500">Faster deliveries next time</p>

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Location type</p>
          <div className="flex gap-2">
            {KIND_OPTIONS.map(({ key, icon: Icon }) => (
              <button
                key={key}
                type="button"
                onClick={() => setKind(key)}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-full border px-3 py-2 text-sm font-semibold ${
                  kind === key ? "border-gold bg-gold/10 text-ink" : "border-[var(--border-faint)] text-ink-500"
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={2.25} aria-hidden />
                {key}
              </button>
            ))}
          </div>
          {kind === "Other" && (
            <input
              value={otherName}
              onChange={(e) => setOtherName(e.target.value)}
              placeholder="Name this location (e.g. Mum's place, Gym)"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              autoFocus
            />
          )}
        </div>

        {step === "menu" ? (
          <div className="space-y-3">
            <button
              type="button"
              onClick={useCurrentLocation}
              disabled={busy || locating || needsName}
              className="flex w-full items-center gap-3 rounded-2xl border border-gold bg-gold/10 p-3.5 text-left disabled:opacity-60"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold/20 text-gold">
                <LocateFixed className="h-5 w-5" strokeWidth={2.25} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">
                  {locating ? "Locating…" : "Use my current location"}
                </span>
                <span className="block text-xs text-ink-500">Automatically detect where I am</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-gold" strokeWidth={2.25} aria-hidden />
            </button>

            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-[var(--border-faint)]" />
              <span className="text-xs font-semibold text-ink-500">or</span>
              <span className="h-px flex-1 bg-[var(--border-faint)]" />
            </div>

            <button
              type="button"
              onClick={() => (needsName ? setError("Give this location a name.") : setShowPicker(true))}
              className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border-faint)] p-3.5 text-left disabled:opacity-60"
              disabled={needsName}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--surface-muted))] text-ink-500">
                <Map className="h-5 w-5" strokeWidth={2.25} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">Choose on map</span>
                <span className="block text-xs text-ink-500">Pin your exact location</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-500/60" strokeWidth={2.25} aria-hidden />
            </button>

            <button
              type="button"
              onClick={() => (needsName ? setError("Give this location a name.") : setStep("manual"))}
              className="flex w-full items-center gap-3 rounded-2xl border border-[var(--border-faint)] p-3.5 text-left disabled:opacity-60"
              disabled={needsName}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--surface-muted))] text-ink-500">
                <Keyboard className="h-5 w-5" strokeWidth={2.25} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] font-bold text-ink">Enter address manually</span>
                <span className="block text-xs text-ink-500">Type the full address</span>
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-ink-500/60" strokeWidth={2.25} aria-hidden />
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <input
              value={manualArea}
              onChange={(e) => setManualArea(e.target.value)}
              placeholder="Area (e.g. Kololo)"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              autoFocus
            />
            <input
              value={manualAddress}
              onChange={(e) => setManualAddress(e.target.value)}
              placeholder="Address / landmark"
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setStep("menu")}
                className="flex-1 rounded-full border border-[var(--border-faint)] py-2.5 text-sm font-bold text-ink"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => persist({ area: manualArea.trim() || undefined, address: manualAddress.trim() || undefined })}
                disabled={busy || needsName}
                className="flex-[2] rounded-full bg-gold py-2.5 text-sm font-bold text-ink-gold disabled:opacity-60"
              >
                {busy ? "Saving…" : "Save location"}
              </button>
            </div>
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {step === "menu" && (
          <button type="button" onClick={onClose} className="block w-full text-center text-sm font-semibold text-ink-500 underline">
            Skip for now
          </button>
        )}
      </div>

      {showPicker && (
        <LocationMapPicker
          onCancel={() => setShowPicker(false)}
          onConfirm={(loc) => {
            setShowPicker(false);
            persist({ lat: loc.lat, lng: loc.lng, area: loc.area ?? undefined, address: loc.address ?? undefined });
          }}
        />
      )}
    </Modal>
  );
}
