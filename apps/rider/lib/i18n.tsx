"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

export type Language = "en" | "lg";

const STORAGE_KEY = "tuma-language";

// Starter dictionary — covers the always-visible chrome (nav, header,
// account). Translating every screen in both apps is a much bigger job;
// this wires up the mechanism and the switch so screens can be added to
// this dictionary incrementally without touching the plumbing again.
const STRINGS: Record<string, { en: string; lg: string }> = {
  nav_home: { en: "Home", lg: "Awaka" },
  nav_orders: { en: "Orders", lg: "Ebiragiddwa" },
  nav_jobs: { en: "Jobs", lg: "Emirimu" },
  nav_active: { en: "Active", lg: "Ebikola" },
  nav_chat: { en: "Chat", lg: "Emboozi" },
  nav_wallet: { en: "Wallet", lg: "Ensawo" },
  nav_account: { en: "Account", lg: "Akawunti" },
  account_title: { en: "Account", lg: "Akawunti" },
  appearance_title: { en: "Appearance", lg: "Endabika" },
  appearance_auto: { en: "Auto", lg: "Byokka" },
  appearance_light: { en: "Light", lg: "Ekyakaawo" },
  appearance_dark: { en: "Dark", lg: "Ekizikiza" },
  language_title: { en: "Language", lg: "Olulimi" },
  language_english: { en: "English", lg: "Olungereza" },
  language_luganda: { en: "Luganda", lg: "Oluganda" },
  log_out: { en: "Log out", lg: "Fuluma" },
  change_location: { en: "Change location", lg: "Kyusa ekifo" },
  locating: { en: "Locating…", lg: "Nnoonya ekifo…" },
};

export type TranslationKey = keyof typeof STRINGS;

function readStored(): Language {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "en" || v === "lg") return v;
  } catch {}
  return "en";
}

const LanguageContext = createContext<{ language: Language; setLanguage: (l: Language) => void }>({
  language: "en",
  setLanguage: () => {},
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");

  useEffect(() => {
    setLanguageState(readStored());
  }, []);

  function setLanguage(next: Language) {
    setLanguageState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  return <LanguageContext.Provider value={{ language, setLanguage }}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}

export function useTranslate() {
  const { language } = useLanguage();
  return (key: TranslationKey) => STRINGS[key]?.[language] ?? STRINGS[key]?.en ?? key;
}
