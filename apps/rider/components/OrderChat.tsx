"use client";

import type { ChatMessage } from "@tuma/shared";
import { Camera, Check, CheckCheck, Clock, Mic, Pause, Play, Send, Square, Trash2 } from "lucide-react";
import { PhotoProvider, PhotoView } from "react-photo-view";
import "react-photo-view/dist/react-photo-view.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth-context";
import { getQueuedMessages, queueMessage, removeQueuedMessage, type QueuedMessage } from "../lib/chat-outbox";
import { compressImage } from "../lib/image-compress";
import { useLivePolling } from "../lib/use-live-polling";
import { useVoiceNoteMaxSeconds } from "../lib/useVoiceNoteMaxSeconds";

function formatTime(iso: string): string {
  const d = new Date(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** m:ss, for a recording's running length or a preview's fixed one. */
function formatDuration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function ImageBubble({ messageId }: { messageId: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    api
      .chatMediaBlob(messageId)
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
  }, [messageId]);

  if (!url) return <div className="h-40 w-48 animate-pulse rounded-2xl bg-[rgb(var(--surface-muted))]" />;
  return (
    // Tapping opens a full-screen viewer (pinch to zoom, drag to pan, swipe
    // between photos in this conversation) via the PhotoProvider wrapping
    // the whole message list below.
    <PhotoView src={url}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="Photo" className="max-h-64 w-full max-w-[220px] cursor-zoom-in rounded-2xl object-cover" />
    </PhotoView>
  );
}

/** Green = not played yet, blue = already played — same at-a-glance
 * "have I heard this one" signal WhatsApp gives on voice notes. `playedAt`
 * comes from the server (set the first time the listener, not the sender,
 * fetches the audio); `justPlayed` flips the color immediately for
 * whoever's pressing play right now, without waiting for the next poll. */
function VoiceBubble({ messageId, mine, playedAt }: { messageId: string; mine: boolean; playedAt: string | null }) {
  const [status, setStatus] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState(false);
  const [justPlayed, setJustPlayed] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function toggle() {
    if (status === "playing") {
      audioRef.current?.pause();
      setStatus("idle");
      return;
    }
    if (urlRef.current && audioRef.current) {
      audioRef.current.play().catch(() => {});
      setStatus("playing");
      return;
    }
    setStatus("loading");
    setError(false);
    try {
      const blob = await api.chatMediaBlob(messageId);
      setJustPlayed(true);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      const audio = new Audio(url);
      audio.onended = () => setStatus("idle");
      audio.onerror = () => {
        setStatus("idle");
        setError(true);
      };
      audioRef.current = audio;
      await audio.play();
      setStatus("playing");
    } catch {
      setStatus("idle");
      setError(true);
    }
  }

  const played = !!playedAt || justPlayed;

  return (
    <button type="button" onClick={toggle} className="flex items-center gap-2 py-0.5 pr-2">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white ${
          played ? "bg-blue-500" : "bg-green"
        }`}
      >
        {status === "playing" ? (
          <Pause className="h-4 w-4" strokeWidth={2} aria-hidden />
        ) : (
          <Play className="h-4 w-4" strokeWidth={2} aria-hidden />
        )}
      </span>
      <span className={`text-[13px] ${mine ? "" : played ? "text-ink-500" : "font-semibold text-ink"}`}>
        {status === "loading" ? "Loading…" : error ? "Couldn't play — tap to retry" : "Voice message"}
      </span>
    </button>
  );
}

/** Sent (single gray) → delivered (double gray) → read (double green) —
 * shown only on the sender's own outgoing bubbles, same as WhatsApp. */
function MessageTicks({ message }: { message: ChatMessage }) {
  if (message.read) {
    return <CheckCheck className="h-3.5 w-3.5 text-green-500" strokeWidth={2.5} aria-hidden />;
  }
  if (message.delivered_at) {
    return <CheckCheck className="h-3.5 w-3.5 text-ink-500/70" strokeWidth={2.5} aria-hidden />;
  }
  return <Check className="h-3.5 w-3.5 text-ink-500/70" strokeWidth={2.5} aria-hidden />;
}

type Props = {
  orderId: string;
  /** "embedded" (default) sits inside a longer page as a bounded card.
   * "full" fills its parent's height edge-to-edge for a dedicated chat
   * screen. Both follow the app's own light/dark theme — there's no
   * separate chat palette. */
  variant?: "embedded" | "full";
};

export function OrderChat({ orderId, variant = "embedded" }: Props) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const maxRecordSeconds = useVoiceNoteMaxSeconds();
  const [mediaError, setMediaError] = useState<string | null>(null);
  // A stopped recording waits here — played back locally, discarded, or
  // sent — rather than uploading the instant the mic button is released.
  const [preview, setPreview] = useState<{ blob: Blob; url: string; duration: number } | null>(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(() => {
    api
      .getChat(orderId)
      .then((res) => {
        setMessages(res.messages);
        if (res.messages.length > 0) void api.markChatRead(orderId).catch(() => {});
      })
      .catch(() => {});
  }, [orderId]);

  useLivePolling(load, 4000, [load]);

  // Queued text messages are per-order, kept in localStorage so they
  // survive a refresh — flush whatever's waiting whenever we come online
  // (including right away, if we're already online on mount).
  const flushQueued = useCallback(async () => {
    for (const m of getQueuedMessages(orderId)) {
      try {
        await api.sendChat(orderId, m.body);
        removeQueuedMessage(m.localId);
        setQueued((prev) => prev.filter((x) => x.localId !== m.localId));
      } catch {
        break;
      }
    }
    load();
  }, [orderId, load]);

  useEffect(() => {
    setQueued(getQueuedMessages(orderId));
  }, [orderId]);

  useEffect(() => {
    if (navigator.onLine) void flushQueued();
    window.addEventListener("online", flushQueued);
    return () => window.removeEventListener("online", flushQueued);
  }, [flushQueued]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length, queued.length]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
      if (preview) URL.revokeObjectURL(preview.url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nobody's meant to record minutes of audio here — auto-stop (not just
  // warn) once the admin-set cap is hit. Lands in the same review-before-
  // send preview a manual tap on "Stop" would.
  useEffect(() => {
    if (recording && recordSeconds >= maxRecordSeconds) {
      stopRecording();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording, recordSeconds, maxRecordSeconds]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    if (!navigator.onLine) {
      setQueued((prev) => [...prev, queueMessage(orderId, body)]);
      return;
    }
    setSending(true);
    try {
      await api.sendChat(orderId, body);
      load();
    } catch {
      setQueued((prev) => [...prev, queueMessage(orderId, body)]);
    } finally {
      setSending(false);
    }
  }

  async function pickPhoto(file: File) {
    if (!navigator.onLine) {
      setMediaError("Photos need a connection — try again once you're back online.");
      if (photoInputRef.current) photoInputRef.current.value = "";
      return;
    }
    setSending(true);
    setMediaError(null);
    try {
      const compressed = await compressImage(file);
      await api.sendChatMedia(orderId, "image", compressed);
      load();
    } catch {
      setMediaError("Couldn't send that photo. Please try again.");
    } finally {
      setSending(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  }

  async function startRecording() {
    setMediaError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 24000 });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        // Hand off to a preview instead of uploading straight away — the
        // stop button shouldn't double as a silent "send".
        setPreview({ blob, url: URL.createObjectURL(blob), duration: recordSeconds });
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setMediaError("Couldn't access the microphone — check your browser's permission for this site.");
    }
  }

  function stopRecording() {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    setRecording(false);
    mediaRecorderRef.current?.stop();
  }

  function discardPreview() {
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setPreviewPlaying(false);
  }

  function togglePreviewPlayback() {
    if (!preview) return;
    if (previewPlaying) {
      previewAudioRef.current?.pause();
      setPreviewPlaying(false);
      return;
    }
    if (!previewAudioRef.current) {
      const audio = new Audio(preview.url);
      audio.onended = () => setPreviewPlaying(false);
      previewAudioRef.current = audio;
    }
    previewAudioRef.current.currentTime = 0;
    previewAudioRef.current.play().catch(() => {});
    setPreviewPlaying(true);
  }

  async function sendPreview() {
    if (!preview) return;
    if (!navigator.onLine) {
      setMediaError("Voice messages need a connection — try again once you're back online.");
      return;
    }
    const { blob, url } = preview;
    setSending(true);
    setMediaError(null);
    try {
      await api.sendChatMedia(orderId, "voice", blob);
      load();
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      URL.revokeObjectURL(url);
      setPreview(null);
      setPreviewPlaying(false);
    } catch {
      setMediaError("Couldn't send that voice message. Please try again.");
    } finally {
      setSending(false);
    }
  }

  const bubbles = (
    <>
      {messages.length === 0 && queued.length === 0 && (
        <p className="py-8 text-center text-xs text-ink-500">No messages yet — say hello to your customer.</p>
      )}
      {messages.map((m) => {
        const mine = m.sender_id === user?.id;

        return (
          <div key={m.id} className={`flex items-end gap-2 ${mine ? "justify-end" : "justify-start"}`}>
            <div className={`flex max-w-[75%] flex-col ${mine ? "items-end" : "items-start"}`}>
              <div
                className={`text-[14px] leading-snug shadow-sm ${m.type === "text" ? "px-4 py-2.5" : "p-1.5"} ${
                  mine
                    ? "rounded-[20px] rounded-br-md bg-gold text-[#0A0A0A]"
                    : "rounded-[20px] rounded-bl-md bg-[rgb(var(--surface-card))] text-ink"
                }`}
              >
                {m.type === "image" && <ImageBubble messageId={m.id} />}
                {m.type === "voice" && <VoiceBubble messageId={m.id} mine={mine} playedAt={m.played_at} />}
                {m.type === "text" && m.body}
              </div>
              <span className="mt-1 flex items-center gap-1 px-1 text-[10px] text-ink-500/70">
                {formatTime(m.created_at)}
                {mine && <MessageTicks message={m} />}
              </span>
            </div>
          </div>
        );
      })}
      {queued.map((q) => (
        <div key={q.localId} className="flex items-end justify-end gap-2">
          <div className="flex max-w-[75%] flex-col items-end">
            <div className="rounded-[20px] rounded-br-md bg-gold/50 px-4 py-2.5 text-[14px] leading-snug text-[#0A0A0A] shadow-sm">
              {q.body}
            </div>
            <span className="mt-1 flex items-center gap-1 px-1 text-[10px] text-ink-500/70">
              Queued
              <Clock className="h-3 w-3" strokeWidth={2} aria-hidden />
            </span>
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </>
  );

  const composer = (
    <div className="space-y-1.5">
      {mediaError && <p className="px-1 text-xs text-red-600">{mediaError}</p>}
      <form onSubmit={send} className="flex items-center gap-2">
        <input
          ref={photoInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void pickPhoto(file);
          }}
        />

        {preview ? (
          // Stopped, not yet sent: listen back, bin it, or send it.
          <div className="flex h-[46px] flex-1 items-center gap-2 rounded-full bg-[rgb(var(--surface-muted))] pl-2 pr-4">
            <button
              type="button"
              onClick={discardPreview}
              aria-label="Discard recording"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-500"
            >
              <Trash2 className="h-4.5 w-4.5" strokeWidth={2} aria-hidden />
            </button>
            <button
              type="button"
              onClick={togglePreviewPlayback}
              aria-label={previewPlaying ? "Pause" : "Play back recording"}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gold text-[#0A0A0A]"
            >
              {previewPlaying ? (
                <Pause className="h-4 w-4" strokeWidth={2.25} aria-hidden />
              ) : (
                <Play className="h-4 w-4" strokeWidth={2.25} aria-hidden />
              )}
            </button>
            <span className="flex-1 text-sm text-ink">{formatDuration(preview.duration)}</span>
          </div>
        ) : (
          <div className="relative min-w-0 flex-1">
            {recording ? (
              <div className="flex h-[46px] items-center gap-2 rounded-full bg-[rgb(var(--surface-muted))] pl-4 pr-2">
                <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-500" />
                <span className="flex-1 text-sm text-ink">
                  Recording… {formatDuration(recordSeconds)} / {formatDuration(maxRecordSeconds)}
                </span>
              </div>
            ) : (
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Message…"
                className="w-full rounded-full border border-[var(--border-faint)] bg-[rgb(var(--surface-input))] py-3.5 pl-4 pr-4 text-sm text-ink outline-none placeholder:text-ink-500 focus:border-gold"
              />
            )}
          </div>
        )}

        {/* Camera and mic/send share the trailing edge on purpose — both
            are "attach something" actions, so they read as one group. */}
        {!preview && (
          <button
            type="button"
            onClick={() => photoInputRef.current?.click()}
            disabled={sending || recording}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-500 disabled:opacity-40"
            aria-label="Send a photo"
          >
            <Camera className="h-6 w-6" strokeWidth={1.75} aria-hidden />
          </button>
        )}

        {preview ? (
          <button
            type="button"
            onClick={sendPreview}
            disabled={sending}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#0A0A0A] shadow-[0_4px_12px_rgba(201,162,39,0.35)] transition-opacity disabled:opacity-40"
            aria-label="Send voice message"
          >
            <Send className="h-5 w-5" strokeWidth={2.25} />
          </button>
        ) : recording ? (
          <button
            type="button"
            onClick={stopRecording}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-600 text-white"
            aria-label="Stop recording"
          >
            <Square className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </button>
        ) : draft.trim() ? (
          <button
            type="submit"
            disabled={sending}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#0A0A0A] shadow-[0_4px_12px_rgba(201,162,39,0.35)] transition-opacity disabled:opacity-40"
            aria-label="Send message"
          >
            <Send className="h-5 w-5" strokeWidth={2.25} />
          </button>
        ) : (
          <button
            type="button"
            onClick={startRecording}
            disabled={sending}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gold text-[#0A0A0A] shadow-[0_4px_12px_rgba(201,162,39,0.35)] disabled:opacity-40"
            aria-label="Record a voice message"
          >
            <Mic className="h-5 w-5" strokeWidth={2.25} />
          </button>
        )}
      </form>
    </div>
  );

  if (variant === "full") {
    return (
      <PhotoProvider>
        <div className="flex min-h-0 flex-1 flex-col bg-cream">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">{bubbles}</div>
          <div className="shrink-0 border-t border-[var(--border-faint)] bg-[rgb(var(--surface-card))] px-3 py-2.5">
            {composer}
          </div>
        </div>
      </PhotoProvider>
    );
  }

  return (
    <PhotoProvider>
      <section className="space-y-2.5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-500">Chat</h2>
        <div className="max-h-80 space-y-3 overflow-y-auto rounded-[28px] bg-[rgb(var(--surface-muted))] p-4">
          {bubbles}
        </div>
        {composer}
      </section>
    </PhotoProvider>
  );
}
