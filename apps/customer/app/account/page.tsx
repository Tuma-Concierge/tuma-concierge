"use client";

import { MATCHING_MODE_DESCRIPTIONS, MATCHING_MODE_LABELS, type MatchingMode } from "@tuma/shared";
import { LogOut, Shield, Wallet } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppearanceSettings } from "../../components/AppearanceSettings";
import { ChangePasswordPanel } from "../../components/ChangePasswordPanel";
import { LanguageSettings } from "../../components/LanguageSettings";
import { ProfilePhoto } from "../../components/ProfilePhoto";
import { SavedLocations } from "../../components/SavedLocations";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

function MatchingPreference() {
  const { user, updateUser } = useAuth();
  const [enabledModes, setEnabledModes] = useState<MatchingMode[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((res) => setEnabledModes(res.settings.enabledModes))
      .catch(() => {});
  }, []);

  if (enabledModes.length <= 1) return null; // admin's only offering one mode — nothing to choose

  async function choose(mode: MatchingMode) {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateMatchingPreference(mode);
      updateUser({ ...user, defaultMatchingMode: mode });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const current = user?.defaultMatchingMode ?? enabledModes[0];

  return (
    <section className="home-card space-y-2.5">
      <h2 className="text-sm font-semibold text-ink">How should riders be matched?</h2>
      {enabledModes.map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={busy}
          onClick={() => choose(mode)}
          className={`flex w-full items-start gap-2.5 rounded-xl border p-2.5 text-left disabled:opacity-60 ${
            current === mode ? "border-gold bg-gold/10" : "border-[var(--border-faint)]"
          }`}
        >
          <span
            className={`mt-0.5 h-4 w-4 shrink-0 rounded-full border-2 ${
              current === mode ? "border-gold bg-gold" : "border-[var(--border-faint)]"
            }`}
          />
          <span>
            <span className="block text-sm font-semibold text-ink">{MATCHING_MODE_LABELS[mode]}</span>
            <span className="block text-xs text-ink-500">{MATCHING_MODE_DESCRIPTIONS[mode]}</span>
          </span>
        </button>
      ))}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}

export default function AccountPage() {
  const { user, logout } = useAuth();

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Account</h1>

      <section className="home-card flex items-center gap-3">
        <ProfilePhoto />
        <span>
          <span className="block text-[15px] font-bold text-ink">{user?.name ?? "—"}</span>
          <span className="block text-sm text-ink-500">{user?.phone}</span>
        </span>
      </section>

      <Link
        href="/wallet"
        className="home-card flex items-center gap-3 !rounded-2xl !py-3 text-sm font-semibold text-ink"
      >
        <Wallet className="h-5 w-5 text-gold" strokeWidth={1.75} aria-hidden />
        Wallet
      </Link>

      <MatchingPreference />

      <AppearanceSettings />

      <LanguageSettings />

      <ChangePasswordPanel />

      <SavedLocations />

      {user?.role === "admin" && (
        <Link
          href="/admin"
          className="home-card flex items-center gap-3 !rounded-2xl !py-3 text-sm font-semibold text-ink"
        >
          <Shield className="h-5 w-5 text-green" strokeWidth={1.75} aria-hidden />
          Rider verification (admin)
        </Link>
      )}

      <button
        onClick={logout}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink"
      >
        <LogOut className="h-4 w-4" strokeWidth={2} aria-hidden />
        Log out
      </button>
    </div>
  );
}
