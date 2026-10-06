"use client";

import { hasPermission, type ActivityLogEntry } from "@tuma/shared";
import { History, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth-context";

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Logged in",
  "user.status": "Changed account status",
  "rider.verify": "Changed rider verification",
  "settings.update": "Updated settings",
  "staff.invite": "Invited staff",
  "staff.role_change": "Changed staff role",
  "staff.status": "Changed staff status",
  "staff.reset_password": "Reset staff password",
  "activity.revert": "Reverted an action",
};

function formatWhen(value: string): string {
  return new Date(`${value.replace(" ", "T")}Z`).toLocaleString("en-UG", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function EntryRow({ entry, canRevert, onReverted }: { entry: ActivityLogEntry; canRevert: boolean; onReverted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function revert() {
    setBusy(true);
    setError(null);
    try {
      await api.adminRevertActivity(entry.id);
      setConfirming(false);
      onReverted();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const showRevert = canRevert && !!entry.revertible && !entry.reverted_at && entry.action !== "activity.revert";

  return (
    <li className="home-card space-y-1.5 !rounded-2xl !px-3 !py-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">{entry.summary}</span>
          <span className="block text-xs text-ink-500">
            {entry.actor_name} · {ACTION_LABELS[entry.action] ?? entry.action} · {formatWhen(entry.created_at)}
          </span>
        </span>
        {entry.reverted_at && (
          <span className="shrink-0 rounded-full bg-[rgb(var(--surface-muted))] px-2 py-0.5 text-xs font-semibold text-ink-500">
            Reverted
          </span>
        )}
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {showRevert &&
        (confirming ? (
          <div className="flex gap-2 pt-1">
            <button
              onClick={revert}
              disabled={busy}
              className="flex h-8 flex-1 items-center justify-center rounded-full bg-red-600 text-xs font-semibold text-white disabled:opacity-60"
            >
              {busy ? "Reverting…" : "Confirm revert"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="h-8 flex-1 rounded-full border border-[var(--border-faint)] text-xs font-semibold text-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="flex h-8 items-center gap-1.5 rounded-full border border-[var(--border-faint)] px-3 text-xs font-semibold text-ink"
          >
            <RotateCcw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Revert
          </button>
        ))}
    </li>
  );
}

export default function ActivityLogPage() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<ActivityLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canView = hasPermission(user?.adminRole ?? null, "activity_log.view");
  const canRevert = user?.adminRole === "super_admin";

  const reload = useCallback(() => {
    api
      .adminActivityLog({ limit: 100 })
      .then((res) => setEntries(res.entries))
      .catch((err) => setError(errorMessage(err)));
  }, []);

  useEffect(() => {
    if (canView) reload();
  }, [canView, reload]);

  if (user && !canView) {
    return (
      <div className="px-4 pt-6">
        <p className="text-sm text-ink-500">Your role doesn&apos;t include the activity log.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Activity log</h1>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {entries === null ? (
        <p className="text-sm text-ink-500">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-500">
          <History className="mx-auto mb-2 h-6 w-6 text-ink-500" strokeWidth={1.5} aria-hidden />
          No activity recorded yet.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((entry) => (
            <EntryRow key={entry.id} entry={entry} canRevert={canRevert} onReverted={reload} />
          ))}
        </ul>
      )}
    </div>
  );
}
