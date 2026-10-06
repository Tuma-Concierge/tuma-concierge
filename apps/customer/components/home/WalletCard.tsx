"use client";

import type { CustomerWallet } from "@tuma/shared";
import { ArrowRight, Wallet as WalletIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { formatUgx } from "../../lib/order-display";

export function WalletCard() {
  const [wallet, setWallet] = useState<CustomerWallet | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getWallet()
      .then((res) => {
        if (!cancelled) setWallet(res);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!wallet) return null;

  return (
    <Link href="/wallet" className="home-card flex items-center gap-3 !rounded-2xl !py-3.5">
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
        <WalletIcon className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold uppercase tracking-wide text-ink-500">Wallet</span>
        <span className="block text-lg font-bold text-ink">{formatUgx(wallet.balance)}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-ink-500/60" strokeWidth={2.25} aria-hidden />
    </Link>
  );
}
