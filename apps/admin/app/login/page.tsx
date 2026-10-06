"use client";

import { useState } from "react";
import { PasswordInput } from "../../components/PasswordInput";
import { errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

export default function LoginPage() {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(identifier, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-dvh flex-col justify-center px-6 py-10">
      <div className="mx-auto w-full max-w-sm space-y-6">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/tuma-logo-navy.png" alt="Tuma" className="mx-auto h-9 w-auto dark:hidden" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/tuma-logo-white.png" alt="Tuma" className="mx-auto hidden h-9 w-auto dark:block" />
        <p className="text-center text-sm font-semibold uppercase tracking-wide text-ink-500">Admin</p>

        <form onSubmit={onSubmit} className="card space-y-4 !p-5">
          <div className="space-y-1">
            <label className="text-xs font-semibold text-ink-500" htmlFor="identifier">
              Phone or email
            </label>
            <input
              id="identifier"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              placeholder="Phone or email"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold text-ink-500" htmlFor="password">
              Password
            </label>
            <PasswordInput
              id="password"
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-[var(--border-faint)] px-3 py-2.5 text-[15px] outline-none focus:border-gold"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <button
            type="submit"
            disabled={busy}
            className="flex min-h-12 w-full items-center justify-center rounded-full bg-gold px-4 py-3 text-base font-bold text-ink-gold shadow-[0_4px_12px_rgba(201,162,39,0.35)] transition-opacity hover:opacity-95 disabled:opacity-60"
          >
            {busy ? "Please wait…" : "Log in"}
          </button>
        </form>

        <p className="text-center text-xs text-ink-500">
          Admin accounts are provisioned by the platform team — there&apos;s no self-signup here.
        </p>
      </div>
    </div>
  );
}
