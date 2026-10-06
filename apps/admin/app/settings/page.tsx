"use client";

import {
  hasPermission,
  MATCHING_MODE_DESCRIPTIONS,
  MATCHING_MODE_LABELS,
  type MatchingMode,
  type PaymentMethod,
  type PaymentCredentialFieldStatus,
  type PaymentProviderIdentity,
  type PaymentProviderInfo,
} from "@tuma/shared";
import { CreditCard, Mic, Route, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

const ALL_MODES: MatchingMode[] = ["first_to_claim", "nearest_window", "customer_selects"];
const ALL_PROVIDERS: PaymentProviderIdentity[] = ["yo", "flutterwave"];

export default function SettingsPage() {
  const { user } = useAuth();
  const canManagePayments = hasPermission(user?.adminRole ?? null, "payments.manage");
  const [deliveryRatePerKm, setDeliveryRatePerKm] = useState("");
  const [serviceRangeKm, setServiceRangeKm] = useState("");
  const [shoppingDeliveryFee, setShoppingDeliveryFee] = useState("");
  const [enabledModes, setEnabledModes] = useState<MatchingMode[]>(["first_to_claim"]);
  const [nearestWindowSeconds, setNearestWindowSeconds] = useState("");
  const [maxAssignmentMinutes, setMaxAssignmentMinutes] = useState("");
  const [activeProviders, setActiveProviders] = useState<PaymentProviderIdentity[]>(["yo"]);
  const [paymentsDemoMode, setPaymentsDemoMode] = useState(false);
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>(["cash"]);
  const [payoutCheckSeconds, setPayoutCheckSeconds] = useState("120");
  const [providerInfo, setProviderInfo] = useState<PaymentProviderInfo[]>([]);
  const [voiceNoteMaxSeconds, setVoiceNoteMaxSeconds] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [platformEnvironment, setPlatformEnvironment] = useState<"live" | "sandbox">("live");
  const [environmentBusy, setEnvironmentBusy] = useState(false);

  function refreshIntegrations() {
    return api.adminIntegrations().then((res) => setProviderInfo(res.integrations.mobileMoney.providers));
  }

  useEffect(() => {
    Promise.all([api.getSettings(), api.adminIntegrations()])
      .then(([settingsRes, integrationsRes]) => {
        setDeliveryRatePerKm(String(settingsRes.settings.deliveryRatePerKm));
        setServiceRangeKm(String(settingsRes.settings.serviceRangeKm));
        setShoppingDeliveryFee(String(settingsRes.settings.shoppingDeliveryFee));
        setEnabledModes(settingsRes.settings.enabledModes);
        setNearestWindowSeconds(String(settingsRes.settings.nearestWindowSeconds));
        setMaxAssignmentMinutes(String(settingsRes.settings.maxAssignmentMinutes));
        setActiveProviders(settingsRes.settings.paymentsActiveProviders);
        setPaymentsDemoMode(settingsRes.settings.paymentsDemoMode);
        setPaymentMethods(settingsRes.settings.paymentMethods);
        setPayoutCheckSeconds(String(settingsRes.settings.payoutCheckSeconds));
        setPlatformEnvironment(settingsRes.settings.platformEnvironment);
        setVoiceNoteMaxSeconds(String(settingsRes.settings.voiceNoteMaxSeconds));
        setProviderInfo(integrationsRes.integrations.mobileMoney.providers);
      })
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false));
  }, []);

  function toggleMode(mode: MatchingMode) {
    setEnabledModes((prev) => (prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]));
  }

  function toggleProvider(provider: PaymentProviderIdentity) {
    setActiveProviders((prev) =>
      prev.includes(provider) ? prev.filter((p) => p !== provider) : [...prev, provider],
    );
  }

  function makePrimary(provider: PaymentProviderIdentity) {
    setActiveProviders((prev) => [provider, ...prev.filter((p) => p !== provider)]);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.adminUpdateSettings({
        deliveryRatePerKm: Number(deliveryRatePerKm),
        serviceRangeKm: Number(serviceRangeKm),
        shoppingDeliveryFee: Number(shoppingDeliveryFee),
        enabledModes: enabledModes.length > 0 ? enabledModes : ["first_to_claim"],
        nearestWindowSeconds: Number(nearestWindowSeconds),
        maxAssignmentMinutes: Number(maxAssignmentMinutes),
        voiceNoteMaxSeconds: Number(voiceNoteMaxSeconds),
        // Omitted entirely (not just disabled inputs) for an admin without
        // payments.manage — the API rejects the whole request if these are
        // present without it, and this admin may still need to save the
        // unrelated fields above.
        ...(canManagePayments
          ? {
              paymentsActiveProviders: activeProviders.length > 0 ? activeProviders : (["yo"] as PaymentProviderIdentity[]),
              paymentsDemoMode,
              paymentMethods,
              payoutCheckSeconds:Number(payoutCheckSeconds),
            }
          : {}),
      });
      setDeliveryRatePerKm(String(res.settings.deliveryRatePerKm));
      setServiceRangeKm(String(res.settings.serviceRangeKm));
      setShoppingDeliveryFee(String(res.settings.shoppingDeliveryFee));
      setEnabledModes(res.settings.enabledModes);
      setNearestWindowSeconds(String(res.settings.nearestWindowSeconds));
      setMaxAssignmentMinutes(String(res.settings.maxAssignmentMinutes));
      setActiveProviders(res.settings.paymentsActiveProviders);
      setPaymentsDemoMode(res.settings.paymentsDemoMode);
      setPaymentMethods(res.settings.paymentMethods);
      setPayoutCheckSeconds(String(res.settings.payoutCheckSeconds));
      setVoiceNoteMaxSeconds(String(res.settings.voiceNoteMaxSeconds));
      if (canManagePayments) await refreshIntegrations();
      setSaved(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Settings</h1>

      {loading ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-5">
          <section className="home-card space-y-3">
            <h2 className="text-sm font-semibold text-ink">Payment methods</h2>
            <p className="text-sm text-ink-500">Cash is selected by default when available. Keep at least one method active.</p>
            {(["cash", "mobile_money"] as const).map((method) => {
              const checked = paymentMethods.includes(method);
              const lastActive = checked && paymentMethods.length === 1;
              return <label key={method} className="flex min-h-12 items-center justify-between gap-3">
                <span>{method === "cash" ? "Cash" : "Mobile money"}{lastActive && <span className="ml-2 text-xs text-ink-500">At least one must stay active</span>}</span>
                <input type="checkbox" checked={checked} disabled={!canManagePayments || lastActive || busy}
                  onChange={(event) => setPaymentMethods((current) => event.target.checked ? [...current, method] : current.filter((m) => m !== method))} />
              </label>;
            })}
            {paymentMethods.includes("mobile_money") && <label className="block space-y-1 text-sm">
              <span>Payout status check interval (seconds)</span>
              <input type="number" min={60} max={3600} value={payoutCheckSeconds} disabled={!canManagePayments}
                onChange={(event) => setPayoutCheckSeconds(event.target.value)} className="w-full rounded-xl px-3 py-2.5" />
            </label>}
          </section>
          <section className="home-card space-y-3">
            <h2 className="text-sm font-semibold text-ink">Platform data</h2>
            <p className="text-sm text-ink-500">Live and sandbox orders and balances stay separate. Switching does not delete data.</p>
            <label htmlFor="platform-environment" className="text-sm">Current environment</label>
            <select id="platform-environment" value={platformEnvironment} disabled={!canManagePayments || environmentBusy}
              onChange={async (event) => {
                const next = event.target.value as "live" | "sandbox";
                setEnvironmentBusy(true);
                setError(null);
                try { const result = await api.adminSetPlatformEnvironment(next); setPlatformEnvironment(result.platformEnvironment); }
                catch (err) { setError(errorMessage(err)); }
                finally { setEnvironmentBusy(false); }
              }} className="w-full rounded-xl px-3 py-2.5">
              <option value="live">Live</option><option value="sandbox">Sandbox</option>
            </select>
          </section>
          <section className="home-card space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                <SettingsIcon className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden />
              </span>
              <h2 className="text-sm font-semibold text-ink">Delivery pricing</h2>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-ink-500" htmlFor="rate">
                Rate per km (UGX)
              </label>
              <input
                id="rate"
                inputMode="numeric"
                value={deliveryRatePerKm}
                onChange={(e) => setDeliveryRatePerKm(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="1000"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <p className="text-xs text-ink-500">
                A parcel&apos;s cost is distance (pickup → drop-off) × this rate, calculated automatically when
                both points are pinned on the map.
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-ink-500" htmlFor="shopping-fee">
                Shopping delivery fee (UGX)
              </label>
              <input
                id="shopping-fee"
                inputMode="numeric"
                value={shoppingDeliveryFee}
                onChange={(e) => setShoppingDeliveryFee(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="3000"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <p className="text-xs text-ink-500">
                A shopping order has no pickup point to price by distance the way a parcel does — this flat fee
                is added to the items cost instead.
              </p>
            </div>
          </section>

          {canManagePayments && (
          <>
          <section className="home-card space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                <CreditCard className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden />
              </span>
              <h2 className="text-sm font-semibold text-ink">Payments</h2>
            </div>
            <p className="text-xs text-ink-500">
              Turn on one or both aggregators. With both on, the first is used until it has no working API
              keys, then the second takes over automatically — a switch never happens mid-payment.
            </p>

            <label
              className={`flex items-start gap-2.5 rounded-xl border p-3 ${
                paymentsDemoMode ? "border-gold/40 bg-gold/5" : "border-[var(--border-faint)]"
              }`}
            >
              <input
                type="checkbox"
                checked={paymentsDemoMode}
                onChange={(e) => setPaymentsDemoMode(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
              />
              <span>
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-semibold text-ink">Demo mode</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                      paymentsDemoMode ? "bg-gold/15 text-gold" : "bg-[rgb(var(--surface-muted))] text-ink-500"
                    }`}
                  >
                    {paymentsDemoMode ? "On — payments simulated" : "Off — live"}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-ink-500">
                  Every payment runs through the simulator instead of a real aggregator, even if API
                  credentials are saved below and an aggregator is turned on. Use this to test the app, do a
                  demo, or pull the whole platform back to sandbox instantly without touching or deleting any
                  saved credentials.
                </span>
              </span>
            </label>

            <div className="space-y-2">
              {ALL_PROVIDERS.map((provider) => {
                const info = providerInfo.find((p) => p.key === provider);
                const isActive = activeProviders.includes(provider);
                const isPrimary = isActive && activeProviders[0] === provider;
                return (
                  <div key={provider} className="rounded-xl border border-[var(--border-faint)] p-3">
                    <label className="flex items-start gap-2.5">
                      <input
                        type="checkbox"
                        checked={isActive}
                        onChange={() => toggleProvider(provider)}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold text-ink">{info?.displayName ?? provider}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                              info?.configured ? "bg-green/15 text-green" : "bg-[rgb(var(--surface-muted))] text-ink-500"
                            }`}
                          >
                            {info?.configured ? "API keys set" : "No API keys yet"}
                          </span>
                          {isPrimary && (
                            <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[11px] font-semibold text-gold">
                              Primary
                            </span>
                          )}
                        </span>
                        {!info?.configured && (
                          <span className="mt-0.5 block text-xs text-ink-500">
                            Turning this on won&apos;t take effect until its secret keys are added.
                          </span>
                        )}
                        {isActive && !isPrimary && (
                          <button
                            type="button"
                            onClick={() => makePrimary(provider)}
                            className="mt-1 text-xs font-semibold text-gold"
                          >
                            Make primary
                          </button>
                        )}
                      </span>
                    </label>
                    {info && info.credentialFields.length > 0 && (
                      <CredentialFieldsForm
                        provider={provider}
                        displayName={info.displayName}
                        fields={info.credentialFields}
                        onSaved={refreshIntegrations}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          </>
          )}

          <section className="home-card space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                <Route className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden />
              </span>
              <h2 className="text-sm font-semibold text-ink">Rider matching</h2>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-ink-500" htmlFor="range">
                Normal service range (km)
              </label>
              <input
                id="range"
                inputMode="numeric"
                value={serviceRangeKm}
                onChange={(e) => setServiceRangeKm(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="7"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <p className="text-xs text-ink-500">
                We always match the nearest available rider, even beyond this range if nobody closer is
                online — the customer just gets a heads-up that the rider is out of range and the ride may
                cost a bit more.
              </p>
            </div>

            <div className="space-y-2 border-t border-[var(--border-faint)] pt-3">
              <p className="text-xs font-semibold text-ink-500">Matching modes on offer</p>
              {ALL_MODES.map((mode) => (
                <label key={mode} className="flex items-start gap-2.5 rounded-xl border border-[var(--border-faint)] p-2.5">
                  <input
                    type="checkbox"
                    checked={enabledModes.includes(mode)}
                    onChange={() => toggleMode(mode)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
                  />
                  <span>
                    <span className="block text-sm font-semibold text-ink">{MATCHING_MODE_LABELS[mode]}</span>
                    <span className="block text-xs text-ink-500">{MATCHING_MODE_DESCRIPTIONS[mode]}</span>
                  </span>
                </label>
              ))}
              <p className="text-xs text-ink-500">
                When more than one is enabled, each customer picks their own default in their account settings.
                With just one enabled, every order uses it — no choice shown.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-[var(--border-faint)] pt-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-ink-500" htmlFor="window">
                  Nearest-window (sec)
                </label>
                <input
                  id="window"
                  inputMode="numeric"
                  value={nearestWindowSeconds}
                  onChange={(e) => setNearestWindowSeconds(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="90"
                  className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-ink-500" htmlFor="ceiling">
                  Max assignment (min)
                </label>
                <input
                  id="ceiling"
                  inputMode="numeric"
                  value={maxAssignmentMinutes}
                  onChange={(e) => setMaxAssignmentMinutes(e.target.value.replace(/[^\d]/g, ""))}
                  placeholder="5"
                  className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
                />
              </div>
              <p className="col-span-2 text-xs text-ink-500">
                &ldquo;Nearest available&rdquo; collects applicants for this long before auto-assigning the
                closest one. &ldquo;Max assignment&rdquo; is the overall safety net — past this, an order gets
                auto-assigned no matter the mode, so nobody waits forever.
              </p>
            </div>
          </section>

          <section className="home-card space-y-3">
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
                <Mic className="h-4.5 w-4.5" strokeWidth={1.75} aria-hidden />
              </span>
              <h2 className="text-sm font-semibold text-ink">Voice recordings</h2>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold text-ink-500" htmlFor="voiceMax">
                Max recording length (sec)
              </label>
              <input
                id="voiceMax"
                inputMode="numeric"
                value={voiceNoteMaxSeconds}
                onChange={(e) => setVoiceNoteMaxSeconds(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="60"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              <p className="text-xs text-ink-500">
                Applies everywhere someone records audio — a shopping list, an order note, a fee-proposal
                reason, or a chat voice message. Recording auto-stops once it hits this length.
              </p>
            </div>
          </section>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {saved && <p className="text-sm font-medium text-green">Saved.</p>}

          <button
            type="submit"
            disabled={busy}
            className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
          >
            {busy ? "Saving…" : "Save settings"}
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * Per-provider API credential inputs, saved independently of the main
 * "Save settings" button below — these hit their own endpoint immediately
 * (see api.adminSavePaymentCredentials) rather than riding along with the
 * rest of the form, since a wrong key here should fail loudly on its own,
 * not get silently bundled into an otherwise-successful settings save.
 */
function CredentialFieldsForm({
  provider,
  displayName,
  fields,
  onSaved,
}: {
  provider: PaymentProviderIdentity;
  displayName: string;
  fields: PaymentCredentialFieldStatus[];
  onSaved: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const nonBlank = Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim().length > 0));
      await api.adminSavePaymentCredentials(provider, nonBlank);
      setValues({});
      setSaved(true);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onClear(field: string) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api.adminClearPaymentCredential(provider, field);
      await onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5 border-t border-[var(--border-faint)] pt-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-xs font-semibold text-gold"
      >
        {open ? "Hide" : "Set"} {displayName} API credentials
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-semibold text-ink-500" htmlFor={`${provider}-${field.key}`}>
                  {field.label}
                  {field.required && <span className="text-gold"> *</span>}
                </label>
                {field.set && (
                  <button
                    type="button"
                    onClick={() => onClear(field.key)}
                    disabled={busy}
                    className="text-[11px] font-semibold text-ink-500 underline disabled:opacity-60"
                  >
                    Clear
                  </button>
                )}
              </div>
              <input
                id={`${provider}-${field.key}`}
                type={field.secret ? "password" : "text"}
                value={values[field.key] ?? ""}
                onChange={(e) => setValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                placeholder={field.set ? "•••••••• (already set — leave blank to keep)" : field.placeholder}
                autoComplete="off"
                className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              />
              {field.helpText && <p className="text-xs text-ink-500">{field.helpText}</p>}
            </div>
          ))}
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          {saved && <p className="text-xs font-medium text-green">Saved.</p>}
          <button
            type="button"
            onClick={onSave}
            disabled={busy || Object.values(values).every((v) => !v.trim())}
            className="min-h-9 w-full rounded-full border border-gold px-4 text-xs font-bold text-gold disabled:opacity-60"
          >
            {busy ? "Saving…" : `Save ${displayName} credentials`}
          </button>
        </div>
      )}
    </div>
  );
}
