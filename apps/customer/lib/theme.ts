"use client";

import { useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "auto";

const STORAGE_KEY = "tuma-theme";

function computeTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "auto") return mode;
  const hour = new Date().getHours();
  return hour >= 6 && hour < 19 ? "light" : "dark";
}

function apply(mode: ThemeMode) {
  document.documentElement.setAttribute("data-theme", computeTheme(mode));
}

/** Reads/writes the appearance preference (manual light, manual dark, or
 * auto by time of day) and keeps the DOM in sync — including re-checking
 * the clock every minute while "auto" is active and the app stays open
 * across the day/night boundary. */
export function useThemeMode() {
  const [mode, setModeState] = useState<ThemeMode | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(STORAGE_KEY);
    } catch {}
    setModeState(stored === "light" || stored === "dark" || stored === "auto" ? stored : "auto");
  }, []);

  useEffect(() => {
    if (!mode) return;
    apply(mode);
    if (mode !== "auto") return;
    const interval = setInterval(() => apply(mode), 60000);
    return () => clearInterval(interval);
  }, [mode]);

  function setMode(next: ThemeMode) {
    setModeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  return { mode: mode ?? "auto", setMode };
}
