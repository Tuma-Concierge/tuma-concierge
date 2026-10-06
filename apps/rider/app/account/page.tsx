"use client";

import { detectMobileMoneyNetwork, isRiderProfileComplete, mobileMoneyNetworkLabel, type Rider } from "@tuma/shared";
import { CheckCircle2, LogOut, MapPin, Upload, User } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppearanceSettings } from "../../components/AppearanceSettings";
import { ChangePasswordPanel } from "../../components/ChangePasswordPanel";
import { LanguageSettings } from "../../components/LanguageSettings";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";
import { compressImage } from "../../lib/image-compress";

const LocationMapPicker = dynamic(
  () => import("../../components/LocationMapPicker").then((m) => m.LocationMapPicker),
  { ssr: false },
);

function Field({
  label,
  value,
  onChange,
  placeholder,
  required,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-semibold text-ink-500">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
      />
    </div>
  );
}

export default function AccountPage() {
  const { user, rider: authRider, refreshRider, logout } = useAuth();
  const [rider, setRider] = useState<Rider | null>(authRider);

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [vehicleInfo, setVehicleInfo] = useState("");
  const [stageAddress, setStageAddress] = useState("");
  const [stageArea, setStageArea] = useState("");
  const [stageCoords, setStageCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [homeAddress, setHomeAddress] = useState("");
  const [stageName, setStageName] = useState("");
  const [stageChairmanName, setStageChairmanName] = useState("");
  const [stageChairmanContact, setStageChairmanContact] = useState("");
  const [emergencyContactName, setEmergencyContactName] = useState("");
  const [emergencyContactPhone, setEmergencyContactPhone] = useState("");
  const [momoMsisdn, setMomoMsisdn] = useState("");
  const detectedNetwork = useMemo(() => detectMobileMoneyNetwork(momoMsisdn), [momoMsisdn]);

  const [showMap, setShowMap] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uploadingId, setUploadingId] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .myRiderProfile()
      .then((res) => applyRider(res.rider))
      .catch(() => {});
  }, []);

  // Google sign-up already has a verified email on the account — carry it
  // into this field instead of leaving it blank for the rider to retype.
  // Only applies while the field is still untouched, so it never clobbers
  // something they've since edited.
  useEffect(() => {
    if (user?.email && !email) setEmail(user.email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  useEffect(() => {
    if (!user || !rider?.profile_photo_key) {
      setPhotoUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .riderPhotoBlob(user.id)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPhotoUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [user, rider?.profile_photo_key]);

  function applyRider(r: Rider | null) {
    setRider(r);
    if (!r) return;
    setFirstName(r.first_name ?? "");
    setLastName(r.last_name ?? "");
    setAltPhone(r.alt_phone ?? "");
    setVehicleInfo(r.vehicle_info ?? "");
    setStageAddress(r.stage_address ?? "");
    setStageArea(r.area ?? "");
    setStageCoords(r.stage_lat != null && r.stage_lng != null ? { lat: r.stage_lat, lng: r.stage_lng } : null);
    setHomeAddress(r.home_address ?? "");
    setStageName(r.stage_name ?? "");
    setStageChairmanName(r.stage_chairman_name ?? "");
    setStageChairmanContact(r.stage_chairman_contact ?? "");
    setEmergencyContactName(r.emergency_contact_name ?? "");
    setEmergencyContactPhone(r.emergency_contact_phone ?? "");
    setMomoMsisdn(r.momo_msisdn ?? "");
  }

  const complete = isRiderProfileComplete(rider);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await api.applyAsRider({
        area: stageArea || undefined,
        vehicleInfo: vehicleInfo || undefined,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        email: email || undefined,
        altPhone: altPhone || undefined,
        stageAddress: stageAddress || undefined,
        homeAddress: homeAddress || undefined,
        stageLat: stageCoords?.lat,
        stageLng: stageCoords?.lng,
        stageName: stageName || undefined,
        stageChairmanName: stageChairmanName || undefined,
        stageChairmanContact: stageChairmanContact || undefined,
        emergencyContactName: emergencyContactName || undefined,
        emergencyContactPhone: emergencyContactPhone || undefined,
        momoMsisdn: momoMsisdn || undefined,
      });
      applyRider(res.rider);
      setSaved(true);
      await refreshRider();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onPickIdFile(file: File) {
    setUploadingId(true);
    setError(null);
    try {
      // Kept larger/higher-quality than a casual photo — this has to stay
      // legible enough for an admin to actually verify the ID against.
      // compressImage() passes a PDF through untouched.
      const compressed = await compressImage(file, { maxDimension: 1600, quality: 0.82 });
      const res = await api.uploadRiderIdDocument(compressed);
      applyRider(res.rider);
      await refreshRider();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploadingId(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function onPickPhotoFile(file: File) {
    setUploadingPhoto(true);
    setError(null);
    try {
      const compressed = await compressImage(file, { maxDimension: 640 });
      const res = await api.uploadRiderProfilePhoto(compressed);
      applyRider(res.rider);
      await refreshRider();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploadingPhoto(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Account</h1>

      <section className="home-card flex items-center gap-3">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
          <User className="h-6 w-6" strokeWidth={1.75} aria-hidden />
        </span>
        <span>
          <span className="block text-[15px] font-bold text-ink">{user?.name ?? "—"}</span>
          <span className="block text-sm text-ink-500">{user?.phone}</span>
        </span>
        {rider && (
          <span
            className={`ml-auto shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
              rider.verified ? "bg-green/15 text-green" : "bg-[rgb(var(--surface-muted))] text-ink-500"
            }`}
          >
            {rider.verified ? "Verified" : "Pending"}
          </span>
        )}
      </section>

      <AppearanceSettings />

      <LanguageSettings />

      <ChangePasswordPanel />

      {complete && rider && !rider.verified && (
        <div className="home-card flex items-center gap-3 !border-l-4 !border-l-gold">
          <p className="text-sm text-ink-500">
            Your profile is complete and waiting on an admin to verify it. You&apos;ll be able to see and claim
            jobs as soon as you&apos;re approved — no need to do anything else here.
          </p>
        </div>
      )}

      {!complete && (
        <div className="home-card flex items-center gap-3 !border-l-4 !border-l-gold">
          <p className="text-sm text-ink-500">
            Complete your profile below — an admin can only review and approve you once every required field
            (marked *) is filled in.
          </p>
        </div>
      )}

      <form onSubmit={onSubmit} className="space-y-5">
        <section className="home-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Personal details</h2>
          <div className="grid grid-cols-2 gap-3">
            <Field label="First name" value={firstName} onChange={setFirstName} placeholder="Juma" required />
            <Field label="Last name" value={lastName} onChange={setLastName} placeholder="Okello" required />
          </div>
          <Field label="Email (optional)" value={email} onChange={setEmail} placeholder="you@example.com" type="email" />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-ink-500">Phone</label>
              <input
                disabled
                value={user?.phone ?? ""}
                className="w-full rounded-xl border border-[var(--border-faint)] bg-[rgb(var(--surface-muted))] px-3 py-2.5 text-[15px] text-ink-500 outline-none"
              />
            </div>
            <Field
              label="Alt. phone (optional)"
              value={altPhone}
              onChange={setAltPhone}
              placeholder="+256700000000"
            />
          </div>
        </section>

        <section className="home-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Vehicle</h2>
          <Field
            label="Motorcycle registration number"
            value={vehicleInfo}
            onChange={setVehicleInfo}
            placeholder="UBG 123X"
            required
          />
        </section>

        <section className="home-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Locations</h2>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-ink-500">
              Stage location <span className="text-red-500">*</span>
            </label>
            <button
              type="button"
              onClick={() => setShowMap(true)}
              className="flex w-full items-center gap-2 rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-left text-[15px] text-ink"
            >
              <MapPin className="h-4 w-4 shrink-0 text-gold" strokeWidth={2} aria-hidden />
              <span className="truncate">{stageAddress || "Set your stage location on the map"}</span>
            </button>
          </div>
          <Field label="Home address" value={homeAddress} onChange={setHomeAddress} placeholder="Ntinda, Kampala" required />
        </section>

        <section className="home-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Stage details</h2>
          <Field label="Stage name" value={stageName} onChange={setStageName} placeholder="Ntinda Trading Center Stage" required />
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Stage chairman name"
              value={stageChairmanName}
              onChange={setStageChairmanName}
              placeholder="Chairman's full name"
              required
            />
            <Field
              label="Stage chairman contact"
              value={stageChairmanContact}
              onChange={setStageChairmanContact}
              placeholder="+256700000000"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Emergency contact name"
              value={emergencyContactName}
              onChange={setEmergencyContactName}
              placeholder="Next of kin"
              required
            />
            <Field
              label="Emergency contact phone"
              value={emergencyContactPhone}
              onChange={setEmergencyContactPhone}
              placeholder="+256700000000"
              required
            />
          </div>
        </section>

        <section className="home-card space-y-3">
          <h2 className="text-sm font-semibold text-ink">Payout</h2>
          <Field
            label="Mobile money number (optional)"
            value={momoMsisdn}
            onChange={setMomoMsisdn}
            placeholder="0772345678"
          />
          {detectedNetwork && (
            <p className="px-1 text-xs font-semibold text-ink-500">{mobileMoneyNetworkLabel(detectedNetwork)} detected</p>
          )}
          <p className="text-xs text-ink-500">This is where your delivery payouts are sent once a job settles.</p>
        </section>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {saved && <p className="text-sm font-medium text-green">Saved.</p>}

        <button
          type="submit"
          disabled={busy}
          className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
      </form>

      <section className="home-card space-y-3">
        <h2 className="text-sm font-semibold text-ink">
          Profile photo <span className="text-red-500">*</span>
        </h2>
        <p className="text-xs text-ink-500">
          A clear photo of your face — this is what customers see once you take their order, so they know
          who&apos;s arriving.
        </p>
        <div className="flex items-center gap-3">
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photoUrl}
              alt="Your profile photo"
              className="h-16 w-16 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--surface-muted))] text-ink-500">
              <User className="h-7 w-7" strokeWidth={1.5} aria-hidden />
            </span>
          )}
          <input
            ref={photoInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onPickPhotoFile(file);
            }}
          />
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            disabled={uploadingPhoto}
            className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink disabled:opacity-60"
          >
            {rider?.profile_photo_key ? (
              <CheckCircle2 className="h-4 w-4 text-green" strokeWidth={2} aria-hidden />
            ) : (
              <Upload className="h-4 w-4" strokeWidth={2} aria-hidden />
            )}
            {uploadingPhoto ? "Uploading…" : rider?.profile_photo_key ? "Uploaded — tap to replace" : "Add profile photo"}
          </button>
        </div>
      </section>

      <section className="home-card space-y-3">
        <h2 className="text-sm font-semibold text-ink">
          National ID <span className="text-red-500">*</span>
        </h2>
        <p className="text-xs text-ink-500">
          Used only to verify your identity. It is never shown publicly or shared outside admin review.
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void onPickIdFile(file);
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingId}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink disabled:opacity-60"
        >
          {rider?.national_id_key ? (
            <CheckCircle2 className="h-4 w-4 text-green" strokeWidth={2} aria-hidden />
          ) : (
            <Upload className="h-4 w-4" strokeWidth={2} aria-hidden />
          )}
          {uploadingId ? "Uploading…" : rider?.national_id_key ? "Uploaded — tap to replace" : "Attach ID snapshot/scan"}
        </button>
      </section>

      <button
        onClick={logout}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-full border border-[var(--border-faint)] px-4 text-sm font-bold text-ink"
      >
        <LogOut className="h-4 w-4" strokeWidth={2} aria-hidden />
        Log out
      </button>

      {showMap && (
        <LocationMapPicker
          initial={stageCoords ?? undefined}
          onCancel={() => setShowMap(false)}
          onConfirm={(loc) => {
            setStageCoords({ lat: loc.lat, lng: loc.lng });
            setStageAddress(loc.address ?? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}`);
            setStageArea(loc.area ?? "");
            setShowMap(false);
          }}
        />
      )}
    </div>
  );
}
