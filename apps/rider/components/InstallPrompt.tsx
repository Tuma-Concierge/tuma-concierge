"use client";

import { Download, X } from "lucide-react";
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const DISMISS_KEY = "tuma-install-dismissed-at";
const DISMISS_DAYS = 7;

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/** Chrome/Android only fire `beforeinstallprompt` (and never show their own
 * banner automatically anymore) — we capture it and show our own prompt
 * right away. iOS Safari never fires that event at all, so there we show
 * static "Share → Add to Home Screen" instructions instead. */
export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isStandalone()) return;

    const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (dismissedAt && Date.now() - dismissedAt < DISMISS_DAYS * 86400000) return;

    if (isIos()) {
      setIosHint(true);
      setVisible(true);
      return;
    }

    function onBeforeInstallPrompt(e: Event) {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setVisible(true);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  }, []);

  function dismiss() {
    setVisible(false);
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  }

  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    setDeferred(null);
    setVisible(false);
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  }

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-20 z-[60] mx-auto max-w-lg px-4">
      <div className="flex items-center gap-3 rounded-2xl border border-[var(--border-faint)] bg-[rgb(var(--surface-card))] p-3 shadow-lg">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icons/icon-192.png" alt="" className="h-10 w-10 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">Install Tuma Driver</p>
          <p className="truncate text-xs text-ink-500">
            {iosHint ? 'Tap Share, then "Add to Home Screen"' : "Add to your home screen for quick access"}
          </p>
        </div>
        {!iosHint && (
          <button
            onClick={install}
            className="flex shrink-0 items-center gap-1 rounded-full bg-gold px-3 py-2 text-xs font-bold text-ink-gold"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden />
            Install
          </button>
        )}
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 p-1 text-ink-500/60">
          <X className="h-4 w-4" strokeWidth={2} aria-hidden />
        </button>
      </div>
    </div>
  );
}
