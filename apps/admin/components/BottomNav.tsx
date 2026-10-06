"use client";

import { hasPermission } from "@tuma/shared";
import { LayoutGrid, Package, Settings, User, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "../lib/auth-context";

type Tab = { href: string; label: string; icon: LucideIcon };

const ALL_TABS: Tab[] = [
  { href: "/", label: "Overview", icon: LayoutGrid },
  { href: "/people", label: "People", icon: Users },
  { href: "/orders", label: "Orders", icon: Package },
  { href: "/settings", label: "Settings", icon: Settings },
  { href: "/account", label: "Account", icon: User },
];

/** Backend enforcement is what actually matters (see requirePermission on
 * every /admin/* route) — this only avoids showing a staff member a tab
 * that would just 403 the moment they tap it. */
function visibleTabs(role: Parameters<typeof hasPermission>[0]): Tab[] {
  return ALL_TABS.filter((tab) => {
    if (tab.href === "/people") return hasPermission(role, "customers.view") || hasPermission(role, "riders.view");
    if (tab.href === "/settings") return hasPermission(role, "settings.view");
    return true;
  });
}

export function BottomNav() {
  const pathname = usePathname();
  const { user } = useAuth();
  const tabs = visibleTabs(user?.adminRole ?? null);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-50 border-t border-[var(--border-faint)] bg-[rgb(var(--surface-card))] pb-[env(safe-area-inset-bottom)]">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around">
        {tabs.map((tab) => {
          const active = tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          const Icon = tab.icon;
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                className={`flex h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${
                  active ? "text-gold" : "text-ink-500"
                }`}
              >
                <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} aria-hidden />
                <span>{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
