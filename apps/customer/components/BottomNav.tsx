"use client";

import { Home, MessageCircle, ShoppingCart, User } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { api } from "../lib/api";
import { useTranslate, type TranslationKey } from "../lib/i18n";
import { useLivePolling } from "../lib/use-live-polling";

const tabs: { href: string; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { href: "/", labelKey: "nav_home", icon: Home },
  { href: "/orders", labelKey: "nav_orders", icon: ShoppingCart },
  { href: "/chat", labelKey: "nav_chat", icon: MessageCircle },
  { href: "/account", labelKey: "nav_account", icon: User },
];

const UNREAD_POLL_MS = 15000;

export function BottomNav() {
  const pathname = usePathname();
  const [hasUnread, setHasUnread] = useState(false);
  const t = useTranslate();

  useLivePolling(
    () => {
      api
        .getChatThreads()
        .then((res) => setHasUnread(res.threads.some((t) => t.unread)))
        .catch(() => {});
    },
    UNREAD_POLL_MS,
    [],
  );

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border-faint)] bg-[rgb(var(--surface-card))] pb-[env(safe-area-inset-bottom)]">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {tabs.map((tab) => {
          const active =
            tab.href === "/"
              ? pathname === "/"
              : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                  active ? "text-gold" : "text-ink-500"
                }`}
              >
                <span className="relative">
                  <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                  {tab.href === "/chat" && hasUnread && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-gold" aria-hidden />
                  )}
                </span>
                <span>{t(tab.labelKey)}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
