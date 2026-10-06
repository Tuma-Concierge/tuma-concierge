"use client";

import type { SavedLocation } from "@tuma/shared";
import { Home, LocateFixed, Map, MapPin, Type } from "lucide-react";
import dynamic from "next/dynamic";
import { useState } from "react";

const LocationMapPicker = dynamic(() => import("./LocationMapPicker").then((m) => m.LocationMapPicker), { ssr: false });

export type LocationTab = "saved" | "map" | "text";

export type PointState = {
  mode: LocationTab;
  selectedLocationId: string | null;
  area: string;
  address: string;
  geoCoords: { lat: number; lng: number } | null;
  geoStatus: "idle" | "locating" | "done" | "error";
  mapArea: string | null;
  mapAddress: string | null;
};

export const emptyPoint: PointState = {
  mode: "map",
  selectedLocationId: null,
  area: "",
  address: "",
  geoCoords: null,
  geoStatus: "idle",
  mapArea: null,
  mapAddress: null,
};

export function resolvePoint(
  point: PointState,
  locations: SavedLocation[],
): { area?: string; address?: string; lat?: number; lng?: number } {
  const selected = locations.find((l) => l.id === point.selectedLocationId);
  if (selected) {
    return {
      area: selected.area ?? undefined,
      address: selected.address ?? undefined,
      lat: selected.lat ?? undefined,
      lng: selected.lng ?? undefined,
    };
  }
  if (point.mode === "map") {
    const typedArea = point.area.trim() || undefined;
    const typedAddress = point.address.trim() || undefined;
    if (point.mapArea || point.mapAddress) {
      return {
        area: typedArea ?? point.mapArea ?? undefined,
        address: typedAddress ?? point.mapAddress ?? undefined,
        lat: point.geoCoords?.lat,
        lng: point.geoCoords?.lng,
      };
    }
    if (point.geoCoords) {
      return {
        area: typedArea,
        address: typedAddress ?? `Current location (${point.geoCoords.lat.toFixed(4)}, ${point.geoCoords.lng.toFixed(4)})`,
        lat: point.geoCoords.lat,
        lng: point.geoCoords.lng,
      };
    }
    return { area: typedArea, address: typedAddress };
  }
  return { area: point.area.trim() || undefined, address: point.address.trim() || undefined };
}

/** Map/Text/Saved location picker shared by every order-creation flow and
 * the "save a location" prompts. Tab order is Saved (when any exist), then
 * Map, then Text — saved locations are the fastest path when available,
 * and map stays left of text per the product's explicit ordering call. */
export function LocationPicker({
  point,
  setPoint,
  locations,
  detailsLabel = "Landmark / house detail",
}: {
  point: PointState;
  setPoint: (p: PointState) => void;
  locations: SavedLocation[];
  detailsLabel?: string;
}) {
  const [showPicker, setShowPicker] = useState(false);
  const tabs: LocationTab[] = locations.length > 0 ? ["saved", "map", "text"] : ["map", "text"];

  function useMyLocation() {
    setPoint({
      ...point,
      mode: "map",
      geoStatus: "locating",
      selectedLocationId: null,
      mapArea: null,
      mapAddress: null,
    });
    if (!navigator.geolocation) {
      setPoint({ ...point, mode: "map", geoStatus: "error" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        setPoint({
          ...point,
          mode: "map",
          geoStatus: "done",
          selectedLocationId: null,
          mapArea: null,
          mapAddress: null,
          geoCoords: { lat: pos.coords.latitude, lng: pos.coords.longitude },
        }),
      () => setPoint({ ...point, mode: "map", geoStatus: "error" }),
      { timeout: 10000 },
    );
  }

  const pinnedLabel = point.mapAddress || point.mapArea;
  const selected = locations.find((l) => l.id === point.selectedLocationId);

  return (
    <div className="space-y-3">
      <div className="flex rounded-full bg-[rgb(var(--surface-muted))] p-1">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setPoint({ ...point, mode: tab })}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-full py-2 text-xs font-bold ${
              point.mode === tab ? "bg-[rgb(var(--surface-card))] text-ink shadow-sm" : "text-ink-500"
            }`}
          >
            {tab === "saved" && <Home className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
            {tab === "map" && <Map className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
            {tab === "text" && <Type className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />}
            {tab === "saved" ? "Saved" : tab === "map" ? "Map" : "Text address"}
          </button>
        ))}
      </div>

      {point.mode === "saved" && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            {locations.map((loc) => (
              <button
                key={loc.id}
                type="button"
                onClick={() => setPoint({ ...point, selectedLocationId: loc.id })}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  point.selectedLocationId === loc.id
                    ? "border-gold bg-gold/10 text-ink"
                    : "border-[var(--border-faint)] text-ink-500"
                }`}
              >
                {loc.label}
              </button>
            ))}
          </div>
          {selected && (selected.area || selected.address) && (
            <p className="text-xs text-ink-500">{[selected.area, selected.address].filter(Boolean).join(" · ")}</p>
          )}
        </div>
      )}

      {point.mode === "map" && (
        <div className="space-y-2">
          {pinnedLabel && (
            <div className="flex items-start gap-2 rounded-xl border border-gold bg-gold/10 p-3">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold" strokeWidth={2.25} aria-hidden />
              <p className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{pinnedLabel}</p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setShowPicker(true)}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--border-faint)] py-3 text-xs font-bold text-ink"
            >
              <Map className="h-3.5 w-3.5 text-gold" strokeWidth={2.25} aria-hidden />
              {pinnedLabel ? "Change pin" : "Choose on map"}
            </button>
            <button
              type="button"
              onClick={useMyLocation}
              className={`flex w-full items-center justify-center gap-1.5 rounded-xl border py-3 text-xs font-bold ${
                point.geoStatus === "done" && !pinnedLabel
                  ? "border-gold bg-gold/10 text-ink"
                  : "border-[var(--border-faint)] text-ink"
              }`}
            >
              <LocateFixed className="h-3.5 w-3.5 text-gold" strokeWidth={2.25} aria-hidden />
              {point.geoStatus === "locating"
                ? "Locating…"
                : point.geoStatus === "done" && !pinnedLabel
                  ? "Using current location"
                  : "Use my current location instead"}
            </button>
          </div>
          {point.geoStatus === "error" && <p className="text-xs text-red-600">Couldn&apos;t get your location.</p>}

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">
              Add address details <span className="font-normal normal-case text-ink-500/70">(optional)</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={point.area}
                onChange={(e) => setPoint({ ...point, area: e.target.value })}
                placeholder="Area (e.g. Kololo)"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <input
                value={point.address}
                onChange={(e) => setPoint({ ...point, address: e.target.value })}
                placeholder={detailsLabel}
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
            </div>
            <p className="text-xs text-ink-500">
              Riders find you faster when you add a landmark or house detail along with your map pin.
            </p>
          </div>

          {showPicker && (
            <LocationMapPicker
              initial={point.geoCoords ?? undefined}
              onCancel={() => setShowPicker(false)}
              onConfirm={(loc) => {
                setPoint({
                  ...point,
                  mode: "map",
                  geoCoords: { lat: loc.lat, lng: loc.lng },
                  geoStatus: "done",
                  selectedLocationId: null,
                  mapArea: loc.area,
                  mapAddress: loc.address,
                });
                setShowPicker(false);
              }}
            />
          )}
        </div>
      )}

      {point.mode === "text" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            value={point.area}
            onChange={(e) => setPoint({ ...point, area: e.target.value, selectedLocationId: null })}
            placeholder="Area (e.g. Kololo)"
            className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
          />
          <input
            value={point.address}
            onChange={(e) => setPoint({ ...point, address: e.target.value, selectedLocationId: null })}
            placeholder="Address / landmark"
            className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
          />
        </div>
      )}
    </div>
  );
}
