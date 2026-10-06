"use client";

import { ADMIN_ROLE_DESCRIPTIONS, ADMIN_ROLE_LABELS, ADMIN_ROLES, type AdminRole, type StaffMember } from "@tuma/shared";
import { KeyRound, Mail, Plus, ShieldOff, UserCheck, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleDateString("en-UG", { day: "numeric", month: "short", year: "numeric" });
}

function InviteForm({ onInvited, onCancel }: { onInvited: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<AdminRole>("customer_manager");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ emailFailed?: boolean; tempPassword?: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.adminInviteStaff({ name, email, phone: phone || undefined, adminRole: role });
      if (res.emailFailed) {
        setResult({ emailFailed: true, tempPassword: res.tempPassword });
      } else {
        onInvited();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (result?.emailFailed) {
    return (
      <div className="home-card space-y-3 !border-l-4 !border-l-gold">
        <p className="text-sm font-semibold text-ink">Invite created, but the email failed to send</p>
        <p className="text-sm text-ink-500">Share this temporary password with {name} another way:</p>
        <p className="rounded-lg bg-[rgb(var(--surface-muted))] px-3 py-2 text-center font-mono text-sm font-bold text-ink">
          {result.tempPassword}
        </p>
        <button
          onClick={onInvited}
          className="min-h-10 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold"
        >
          Done
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="home-card space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-ink">Invite staff member</h2>
        <button type="button" onClick={onCancel} aria-label="Cancel">
          <X className="h-4 w-4 text-ink-500" strokeWidth={2} aria-hidden />
        </button>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-semibold text-ink-500">Full name</label>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Jane Doe"
          className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-semibold text-ink-500">Email</label>
        <input
          required
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jane@tumaffe.online"
          className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
        />
        <p className="text-xs text-ink-500">Their temporary password is sent here.</p>
      </div>
      <div className="space-y-1">
        <label className="text-xs font-semibold text-ink-500">Phone (optional)</label>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+256700000000"
          className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
        />
      </div>
      <div className="space-y-2">
        <label className="text-xs font-semibold text-ink-500">Role</label>
        {ADMIN_ROLES.map((r) => (
          <label
            key={r}
            className={`flex items-start gap-2.5 rounded-xl border p-2.5 ${role === r ? "border-gold bg-gold/10" : "border-[var(--border-faint)]"}`}
          >
            <input type="radio" name="role" checked={role === r} onChange={() => setRole(r)} className="mt-1 accent-gold" />
            <span>
              <span className="block text-sm font-semibold text-ink">{ADMIN_ROLE_LABELS[r]}</span>
              <span className="block text-xs text-ink-500">{ADMIN_ROLE_DESCRIPTIONS[r]}</span>
            </span>
          </label>
        ))}
      </div>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      <button type="submit" disabled={busy} className="min-h-11 w-full rounded-full bg-gold px-4 text-sm font-bold text-ink-gold disabled:opacity-60">
        {busy ? "Sending invite…" : "Send invite"}
      </button>
    </form>
  );
}

function StaffRow({ member, onChanged }: { member: StaffMember; onChanged: () => void }) {
  const { user: me } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const isSelf = member.id === me?.id;

  async function changeRole(role: string) {
    setBusy(true);
    setError(null);
    try {
      await api.adminChangeStaffRole(member.id, role as never);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus() {
    setBusy(true);
    setError(null);
    try {
      await api.adminSetStaffStatus(member.id, member.status === "active" ? "suspended" : "active");
      setConfirmSuspend(false);
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.adminResetStaffPassword(member.id);
      if (!res.emailed && res.tempPassword) {
        alert(`No email on file — share this temporary password with ${member.name}:\n\n${res.tempPassword}`);
      }
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="home-card space-y-2.5 !rounded-2xl !px-3 !py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-bold text-ink">
            {member.name} {isSelf && <span className="text-xs font-normal text-ink-500">(you)</span>}
          </span>
          <span className="block truncate text-xs text-ink-500">{member.email ?? member.phone}</span>
        </span>
        <span
          className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            member.status === "active" ? "bg-green/15 text-green" : "bg-red-100 text-red-700"
          }`}
        >
          {member.status === "active" ? "Active" : "Suspended"}
        </span>
      </div>

      <select
        value={member.admin_role}
        disabled={busy || isSelf}
        onChange={(e) => changeRole(e.target.value)}
        className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2 text-sm outline-none focus:border-gold disabled:opacity-60"
      >
        {ADMIN_ROLES.map((r) => (
          <option key={r} value={r}>
            {ADMIN_ROLE_LABELS[r]}
          </option>
        ))}
      </select>

      <div className="flex items-center gap-3 text-xs text-ink-500">
        <span>Invited {formatDate(member.invited_at)}</span>
        <span>·</span>
        <span>Last login {formatDate(member.last_login_at)}</span>
        {!!member.force_password_change && (
          <>
            <span>·</span>
            <span className="font-semibold text-gold">Hasn&apos;t set password</span>
          </>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={resetPassword}
          disabled={busy}
          className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--border-faint)] text-xs font-semibold text-ink disabled:opacity-60"
        >
          <KeyRound className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          Reset password
        </button>
        {!isSelf &&
          (confirmSuspend ? (
            <button
              type="button"
              onClick={toggleStatus}
              disabled={busy}
              className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-red-600 text-xs font-semibold text-white disabled:opacity-60"
            >
              Confirm {member.status === "active" ? "suspend" : "reactivate"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmSuspend(true)}
              disabled={busy}
              className="flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-full border border-[var(--border-faint)] text-xs font-semibold text-ink disabled:opacity-60"
            >
              {member.status === "active" ? (
                <>
                  <ShieldOff className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  Suspend
                </>
              ) : (
                <>
                  <UserCheck className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                  Reactivate
                </>
              )}
            </button>
          ))}
      </div>
    </li>
  );
}

export default function StaffPage() {
  const { user } = useAuth();
  const [staff, setStaff] = useState<StaffMember[] | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reload() {
    api
      .adminListStaff()
      .then((res) => setStaff(res.staff))
      .catch((err) => setError(errorMessage(err)));
  }

  useEffect(reload, []);

  if (user && user.adminRole !== "super_admin") {
    return (
      <div className="px-4 pt-6">
        <p className="text-sm text-ink-500">Only a Super Admin can manage staff accounts.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">Staff</h1>
        {!showInvite && (
          <button
            onClick={() => setShowInvite(true)}
            className="flex h-9 items-center gap-1.5 rounded-full bg-gold px-3.5 text-sm font-bold text-ink-gold"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            Invite
          </button>
        )}
      </div>

      {showInvite && (
        <InviteForm
          onInvited={() => {
            setShowInvite(false);
            reload();
          }}
          onCancel={() => setShowInvite(false)}
        />
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {staff === null ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : staff.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-500">
          <Mail className="mx-auto mb-2 h-6 w-6 text-ink-500" strokeWidth={1.5} aria-hidden />
          No staff invited yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {staff.map((member) => (
            <StaffRow key={member.id} member={member} onChanged={reload} />
          ))}
        </ul>
      )}
    </div>
  );
}
