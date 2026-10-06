"use client";

import type { ChatThreadDetail } from "@tuma/shared";
import { ArrowLeft, User } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { OrderChat } from "../../../components/OrderChat";
import { api } from "../../../lib/api";

export default function ChatThreadPage() {
  const params = useParams<{ counterpartId: string }>();
  const counterpartId = params.counterpartId;
  const router = useRouter();
  const [thread, setThread] = useState<ChatThreadDetail | null | undefined>(undefined);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);

  useEffect(() => {
    api
      .getChatThread(counterpartId)
      .then(setThread)
      .catch(() => setThread(null));
  }, [counterpartId]);

  useEffect(() => {
    if (!thread?.counterpartHasPhoto) {
      setPhotoUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .riderPhotoBlob(counterpartId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setPhotoUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [counterpartId, thread?.counterpartHasPhoto]);

  if (thread === undefined) {
    return <div className="flex min-h-dvh items-center justify-center bg-cream text-sm text-ink-500">Loading…</div>;
  }

  if (!thread) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-cream p-4 text-center">
        <p className="text-sm text-ink-500">Couldn&apos;t load this conversation.</p>
        <button type="button" onClick={() => router.push("/chat")} className="text-sm font-semibold text-gold">
          Back to chats
        </button>
      </div>
    );
  }

  return (
    <div className="h-[calc(100dvh-3.5rem-env(safe-area-inset-bottom))]">
      <div className="mx-auto flex h-full max-w-lg flex-col bg-cream">
        <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border-faint)] bg-[rgb(var(--surface-card))] px-3 py-2.5">
          <button
            type="button"
            onClick={() => router.push("/chat")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-500"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={2} aria-hidden />
          </button>
          {/* The rider's own order detail is the closest thing to "their
              profile" from a customer's side — name, rating, delivery info. */}
          <Link href={`/orders/${thread.orderId}`} className="flex min-w-0 flex-1 items-center gap-3">
            {photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gold text-sm font-bold text-[#0A0A0A]">
                <User className="h-5 w-5" strokeWidth={2} aria-hidden />
              </span>
            )}
            <h1 className="min-w-0 flex-1 truncate text-base font-bold text-ink">{thread.counterpartName}</h1>
          </Link>
        </header>
        <OrderChat orderId={thread.orderId} variant="full" />
      </div>
    </div>
  );
}
