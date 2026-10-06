import { ChevronRight, Users } from "lucide-react";

export function TrustBanner() {
  return (
    <div className="home-card flex items-center gap-3 !py-3.5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-navy/15 text-navy">
        <Users className="h-5 w-5" strokeWidth={2} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-bold text-ink">Fast. Reliable. Trusted.</span>
        <span className="block text-xs text-ink-500">Verified riders in your area.</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-ink-500/60" strokeWidth={2} aria-hidden />
    </div>
  );
}
