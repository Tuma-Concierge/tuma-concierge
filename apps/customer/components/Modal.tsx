"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    document.body.style.overflow = "hidden";

    // Android draws its status bar as opaque OS chrome, colored from this
    // meta tag — it's never covered by page content, so without this the
    // bar stays the app's normal navy while everything below it dims,
    // leaving a bright, uncovered-looking seam right at the top of the
    // screen. Swap it to match the dim overlay while the modal is open.
    const meta = document.querySelector('meta[name="theme-color"]');
    const previousThemeColor = meta?.getAttribute("content") ?? null;
    meta?.setAttribute("content", "#0a0a0a");

    return () => {
      document.body.style.overflow = "";
      if (meta && previousThemeColor !== null) meta.setAttribute("content", previousThemeColor);
    };
  }, []);

  if (!mounted) return null;

  // Portaled to <body> rather than rendered in place — a sticky-positioned
  // ancestor (the page header) can end up painting above a same-context
  // fixed overlay regardless of z-index in some browsers, leaving a strip
  // of the header visible through the dim/blur. Being a direct child of
  // <body> keeps this out of that stacking-context fight entirely.
  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center">
      <div
        className="flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[28px] bg-cream shadow-2xl sm:rounded-[28px]"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-faint)] px-5 py-4">
          <h2 className="text-lg font-bold text-ink">{title}</h2>
          <button
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[rgb(var(--surface-muted))] text-ink-500"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={2.25} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
