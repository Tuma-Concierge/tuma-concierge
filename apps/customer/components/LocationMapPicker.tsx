"use client";

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Loader2, LocateFixed, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MapContainer, Marker, TileLayer, useMap, useMapEvents } from "react-leaflet";

// A gold teardrop pin matching the app's icon language, in place of Leaflet's
// default blue-and-white marker image.
const markerIcon = L.divIcon({
  html: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 22s7-7.94 7-12.75A7 7 0 0 0 5 9.25C5 14.06 12 22 12 22Z" fill="#C9A227" stroke="#0A0A0A" stroke-width="1.1"/>
    <circle cx="12" cy="9.4" r="2.6" fill="#FDFBF7"/>
  </svg>`,
  className: "tuma-marker",
  iconSize: [34, 34],
  iconAnchor: [17, 32],
});

// Standard OpenStreetMap tiles — genuinely free, no key or signup required.
// (CARTO's "free" basemaps now gate anonymous use behind an API key, so we
// stick with OSM's own tile server and theme it with CSS instead.)
const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const KAMPALA: [number, number] = [0.3476, 32.5825];

export type PickedLocation = { lat: number; lng: number; area: string | null; address: string | null };

type NominatimResult = {
  lat: string;
  lon: string;
  display_name: string;
  address?: Record<string, string>;
};

function pickArea(address?: Record<string, string>): string | null {
  if (!address) return null;
  return address.suburb || address.neighbourhood || address.town || address.city_district || address.city || null;
}

/** Reverse/forward geocoding via OSM Nominatim — free, no API key. Rate-limited
 * to ~1 req/sec by their usage policy, which is why every call here is
 * debounced or only fires on explicit user action (click, confirm, search submit). */
async function reverseGeocode(lat: number, lng: number): Promise<{ area: string | null; address: string | null }> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&addressdetails=1`,
  );
  if (!res.ok) return { area: null, address: null };
  const data = (await res.json()) as NominatimResult;
  return { area: pickArea(data.address), address: data.display_name ?? null };
}

async function searchPlace(query: string): Promise<NominatimResult[]> {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&countrycodes=ug&limit=5`,
  );
  if (!res.ok) return [];
  return (await res.json()) as NominatimResult[];
}

function ClickToPlace({ onPick }: { onPick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function RecenterOnChange({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center[0], center[1]]);
  return null;
}

export function LocationMapPicker({
  initial,
  onConfirm,
  onCancel,
}: {
  initial?: { lat: number; lng: number };
  onConfirm: (location: PickedLocation) => void;
  onCancel: () => void;
}) {
  const [marker, setMarker] = useState<[number, number] | null>(initial ? [initial.lat, initial.lng] : null);
  const [center, setCenter] = useState<[number, number]>(initial ? [initial.lat, initial.lng] : KAMPALA);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [resolving, setResolving] = useState(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function place(lat: number, lng: number) {
    setMarker([lat, lng]);
    setResults([]);
  }

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      const next: [number, number] = [pos.coords.latitude, pos.coords.longitude];
      setCenter(next);
      place(next[0], next[1]);
    });
  }

  function onSearchChange(value: string) {
    setQuery(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (value.trim().length < 3) {
      setResults([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      const found = await searchPlace(value).catch(() => []);
      setResults(found);
      setSearching(false);
    }, 700);
  }

  function chooseResult(r: NominatimResult) {
    const lat = Number(r.lat);
    const lng = Number(r.lon);
    setCenter([lat, lng]);
    place(lat, lng);
    setQuery(r.display_name);
    setResults([]);
  }

  async function confirm() {
    if (!marker) return;
    setResolving(true);
    const { area, address } = await reverseGeocode(marker[0], marker[1]).catch(() => ({
      area: null,
      address: null,
    }));
    setResolving(false);
    onConfirm({ lat: marker[0], lng: marker[1], area, address });
  }

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-cream">
      <div className="relative z-20 shrink-0 border-b border-[var(--border-faint)] bg-cream p-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" strokeWidth={2} />
          <input
            value={query}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search a place in Uganda…"
            className="w-full rounded-full border border-[var(--border-faint)] py-2.5 pl-9 pr-3 text-sm outline-none focus:border-gold"
          />
        </div>
        {(searching || results.length > 0) && (
          <div className="absolute inset-x-3 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-xl border border-[var(--border-faint)] bg-[rgb(var(--surface-card))] shadow-lg">
            {searching && <div className="p-3 text-xs text-ink-500">Searching…</div>}
            {results.map((r, i) => (
              <button
                key={i}
                onClick={() => chooseResult(r)}
                className="block w-full truncate px-3 py-2 text-left text-sm text-ink hover:bg-[rgb(var(--surface-muted))]"
              >
                {r.display_name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="relative flex-1">
        <MapContainer center={center} zoom={14} className="tuma-map h-full w-full" attributionControl>
          <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
          <ClickToPlace onPick={place} />
          <RecenterOnChange center={center} />
          {marker && <Marker position={marker} icon={markerIcon} />}
          {/* Dark-mode recolor layer — see .tuma-map-tint in globals.css */}
          <div className="tuma-map-tint" aria-hidden />
        </MapContainer>

        <button
          onClick={useMyLocation}
          className="absolute bottom-4 right-4 z-[1000] flex h-11 w-11 items-center justify-center rounded-full bg-[rgb(var(--surface-card))] text-ink shadow-lg"
          aria-label="Use my current location"
        >
          <LocateFixed className="h-5 w-5 text-gold" strokeWidth={2.25} />
        </button>

        {!marker && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="rounded-full bg-ink/80 px-3 py-1.5 text-xs font-medium text-cream">
              Tap the map to drop a pin
            </span>
          </div>
        )}
      </div>

      <div className="flex shrink-0 gap-2 border-t border-[var(--border-faint)] bg-cream p-3">
        <button
          onClick={onCancel}
          className="min-h-12 flex-1 rounded-full border border-[var(--border-faint)] text-sm font-bold text-ink"
        >
          Cancel
        </button>
        <button
          onClick={confirm}
          disabled={!marker || resolving}
          className="flex min-h-12 flex-[2] items-center justify-center gap-2 rounded-full bg-gold text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-50"
        >
          {resolving && <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.5} />}
          {resolving ? "Finding address…" : "Use this location"}
        </button>
      </div>
    </div>
  );
}
