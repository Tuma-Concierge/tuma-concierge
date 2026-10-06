"use client";

import type { ChatThread } from "@tuma/shared";
import { User } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";

function formatTime(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function ThreadAvatar({ counterpartId, hasPhoto }: { counterpartId: string; hasPhoto: boolean }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!hasPhoto) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .userPhotoBlob(counterpartId)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [counterpartId, hasPhoto]);

  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />;
  }
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-gold/15 text-gold">
      <User className="h-6 w-6" strokeWidth={1.75} aria-hidden />
    </span>
  );
}

export default function ChatListPage() {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getChatThreads()
      .then((res) => {
        if (!cancelled) setThreads(res.threads);
      })
      .catch(() => {
        if (!cancelled) setThreads([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (threads === null) {
    return <div className="p-4 text-sm text-ink-500">Loading…</div>;
  }

  if (threads.length === 0) {
    return (
      <div className="flex min-h-[70dvh] flex-col items-center justify-center space-y-2 p-4 text-center">
        <h1 className="text-xl font-bold text-ink">Chat</h1>
        <p className="text-sm text-ink-500">No conversations yet — they&apos;ll show up here once you take a job.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3 px-4 pb-6 pt-4">
      <h1 className="text-xl font-bold text-ink">Chat</h1>
      <ul className="space-y-2">
        {threads.map((t) => (
          <li key={t.counterpartId}>
            <Link
              href={`/chat/${t.counterpartId}`}
              className="home-card flex items-center gap-3 !rounded-2xl !px-3 !py-3"
            >
              <ThreadAvatar counterpartId={t.counterpartId} hasPhoto={t.counterpartHasPhoto} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-bold text-ink">{t.counterpartName}</span>
                <span className={`block truncate text-xs ${t.unread ? "font-semibold text-ink" : "text-ink-500"}`}>
                  {t.lastMessagePreview}
                </span>
              </span>
              <span className="flex shrink-0 flex-col items-end gap-1.5">
                <span className="text-[11px] text-ink-500">{formatTime(t.lastMessageAt)}</span>
                {t.unread && <span className="h-2 w-2 rounded-full bg-gold" aria-hidden />}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
