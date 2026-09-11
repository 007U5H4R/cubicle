"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "framer-motion";
import { ActChip } from "@/components/office/ActChip";
import { RoleGlyph } from "@/components/office/RoleGlyph";
import { useRunStore } from "@/lib/client/runStore";
import type { Envelope, Role } from "@/lib/engine/envelope";

/**
 * TKT-13 Dispatch A (TSK-13.3) — the chronological, virtualized transcript. Reads `messages` straight
 * off the run store (no props in — matches how Office/RunView read the store). Oldest-at-top, never
 * reversed. `from_role === "office"` rows (steer/system frames, no agent turn) are skipped — they
 * carry no `act` and aren't part of the debate transcript.
 */

export interface TranscriptPanelProps {
  /** Reduced-motion switch (wired for real in TKT-17; default false). */
  reduced?: boolean;
  className?: string;
}

const ROLE_NAME: Record<Role, string> = {
  pm: "PM",
  researcher: "Researcher",
  designer: "Designer",
  developer: "Developer",
};

/** Glyph (icon) color — non-text, 3:1 is the applicable floor, so the raw role token is fine. */
const ROLE_GLYPH: Record<Role, string> = {
  pm: "text-role-pm",
  researcher: "text-role-researcher",
  designer: "text-role-designer",
  developer: "text-role-developer",
};

/** DES-002: role-name label color — TEXT, needs 4.5:1. Uses the text-safe `-text` token variants
 * (app/globals.css) instead of the raw role token, which fails AA for researcher/designer. */
const ROLE_TEXT: Record<Role, string> = {
  pm: "text-role-pm-text",
  researcher: "text-role-researcher-text",
  designer: "text-role-designer-text",
  developer: "text-role-developer-text",
};

const NEAR_BOTTOM_PX = 40;
const ROW_ESTIMATE_PX = 96;

/** True once the scroll container is within `NEAR_BOTTOM_PX` of its bottom — the auto-scroll /
 * "stuck to bottom" threshold. Pure so it's unit-testable without jsdom layout. */
export function isNearBottom(scrollTop: number, scrollHeight: number, clientHeight: number, threshold = NEAR_BOTTOM_PX): boolean {
  return scrollHeight - scrollTop - clientHeight <= threshold;
}

/** The "↓ N new" pill only shows once the user has scrolled away from the bottom AND messages have
 * arrived since. Extracted per the brief — jsdom scroll measurement is unreliable, this isn't. */
export function shouldShowNewPill(stuckToBottom: boolean, pendingCount: number): boolean {
  return !stuckToBottom && pendingCount > 0;
}

/** Dependency-free relative-time label ("just now", "12s ago", "4m ago", "2h ago", "3d ago"). */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const deltaMs = now - new Date(iso).getTime();
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface TranscriptRowProps {
  message: Envelope & { from_role: Role };
  isFirstAppearance: boolean;
  reduced: boolean;
}

function TranscriptRow({ message, isFirstAppearance, reduced }: TranscriptRowProps) {
  const slide = reduced ? 0 : 12;
  const duration = reduced ? 0.12 : 0.18;

  return (
    <motion.div
      data-testid="transcript-row"
      data-message-id={message.id}
      initial={isFirstAppearance ? { opacity: 0, y: slide } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration, ease: [0.16, 1, 0.3, 1] }}
      className="flex flex-col gap-1 rounded-md px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span className={ROLE_GLYPH[message.from_role]}>
          <RoleGlyph role={message.from_role} />
        </span>
        <span className={`font-manrope text-sm font-semibold ${ROLE_TEXT[message.from_role]}`}>
          {ROLE_NAME[message.from_role]}
        </span>
        <ActChip act={message.act} size="sm" layoutId={`chip-${message.id}`} />
        <span className="ml-auto shrink-0 font-plex-mono text-xs text-text-muted">
          {relativeTime(message.created_at)}
        </span>
      </div>
      <p className="leading-[var(--leading-relaxed)] text-sm text-text">{message.body}</p>
    </motion.div>
  );
}

export function TranscriptPanel({ reduced = false, className }: TranscriptPanelProps) {
  const snap = useRunStore();
  const messages = snap.messages.filter(
    (m): m is Envelope & { from_role: Role } => m.from_role !== "office"
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const stuckToBottomRef = useRef(stuckToBottom);
  const [pendingCount, setPendingCount] = useState(0);
  const prevLenRef = useRef(0);
  const seenIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    stuckToBottomRef.current = stuckToBottom;
  }, [stuckToBottom]);

  // Generous overscan: jsdom (and any zero-height container before first paint) has no
  // ResizeObserver-driven viewport measurement, so a small overscan would under-render. Real runs
  // are ≤ ~30 messages; capping at 40 keeps this a real virtualizer for the ~100-row ceiling too.
  const overscan = Math.min(messages.length, 40);

  const rowVirtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan,
    getItemKey: (index) => messages[index]!.id,
  });

  const scrollToNewest = useCallback(() => {
    if (messages.length === 0) return;
    rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" });
  }, [messages.length, rowVirtualizer]);

  // New messages: auto-scroll if the user is stuck to the bottom, otherwise queue the "↓ N new" pill.
  useEffect(() => {
    const delta = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (delta <= 0) return;
    if (stuckToBottomRef.current) {
      requestAnimationFrame(scrollToNewest);
    } else {
      setPendingCount((c) => c + delta);
    }
  }, [messages.length, scrollToNewest]);

  // Mark every currently-rendered id as seen *after* commit, so a row only ever animates its entrance
  // once — later re-renders (virtualization recycling, scroll) read `seenIdsRef` without mutating it.
  useEffect(() => {
    for (const m of messages) seenIdsRef.current.add(m.id);
  }, [messages]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    setStuckToBottom(near);
    if (near) setPendingCount(0);
  }, []);

  function handleResumeClick() {
    setStuckToBottom(true);
    setPendingCount(0);
    scrollToNewest();
  }

  const showPill = shouldShowNewPill(stuckToBottom, pendingCount);

  return (
    <div
      data-testid="transcript-panel"
      aria-live="polite"
      aria-atomic="false"
      className={`relative flex h-full min-h-0 flex-col ${className ?? ""}`}
    >
      <div ref={scrollRef} onScroll={handleScroll} className="h-full min-h-0 overflow-y-auto">
        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const message = messages[virtualRow.index]!;
            const isFirstAppearance = !seenIdsRef.current.has(message.id);
            return (
              <div
                key={virtualRow.key}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <TranscriptRow message={message} isFirstAppearance={isFirstAppearance} reduced={reduced} />
              </div>
            );
          })}
        </div>
      </div>

      {showPill && (
        <button
          type="button"
          onClick={handleResumeClick}
          data-testid="transcript-new-pill"
          className="absolute bottom-3 left-1/2 h-9 -translate-x-1/2 rounded-full bg-brand-500 px-4 text-xs font-semibold shadow-md"
          style={{ color: "var(--neutral-0)" }}
        >
          ↓ {pendingCount} new
        </button>
      )}
    </div>
  );
}
