"use client";

import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useAuth } from "../../lib/auth-context";

function greetingForKampala(now = new Date()): "Morning" | "Afternoon" | "Evening" {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Kampala",
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  return "Evening";
}

export function Greeting() {
  const { user } = useAuth();
  const [greeting, setGreeting] = useState<"Morning" | "Afternoon" | "Evening">(
    "Morning",
  );

  useEffect(() => {
    setGreeting(greetingForKampala());
  }, []);

  const firstName = user?.name?.split(" ")[0];

  return (
    <header className="space-y-1.5">
      <h1 className="text-[2rem] font-bold leading-tight tracking-tight text-ink">
        {greeting}
        {firstName ? `, ${firstName}` : ""}
      </h1>
      <p className="text-[15px] leading-snug text-ink-500">
        Ready to shop? Send the list — we handle the rest.
      </p>
      <p className="flex items-center gap-1.5 text-sm font-medium text-green">
        <ShieldCheck className="h-4 w-4 shrink-0" strokeWidth={2.25} aria-hidden />
        Webale. Verified riders near you.
      </p>
    </header>
  );
}
