"use client";

const STRINGS = {
  nav_home: "Home",
  nav_orders: "Orders",
  nav_jobs: "Jobs",
  nav_active: "Active",
  nav_chat: "Chat",
  nav_account: "Account",
  account_title: "Account",
  appearance_title: "Appearance",
  appearance_auto: "Auto",
  appearance_light: "Light",
  appearance_dark: "Dark",
  log_out: "Log out",
  change_location: "Change location",
  locating: "Locating…",
} as const;

export type TranslationKey = keyof typeof STRINGS;
export function useTranslate() { return (key: TranslationKey) => STRINGS[key] ?? key; }
