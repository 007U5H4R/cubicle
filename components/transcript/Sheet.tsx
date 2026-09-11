"use client";
import { useEffect, useState } from "react";
import { motion, useMotionValue, animate, AnimatePresence } from "framer-motion";
import { TranscriptPanel } from "./TranscriptPanel";
import { useRunStore } from "@/lib/client/runStore";

// TKT-16 — the mobile transcript bottom sheet (Design.md §3.3/§4). Renders in place of the inline
// `TranscriptPanel` below the `md:` breakpoint so exactly one `[data-testid="transcript-panel"]`
// exists in the DOM at any viewport (RunView/Office pick Sheet vs the inline panel via
// `useIsMobile`, never both). Peek bar is fixed to the viewport bottom at 96px (incl. safe area);
// tapping it or the backdrop scrim toggles the sheet to `80vh`. Drag-to-open/close is layered on
// top of tap via framer's `drag="y"` — tap-to-toggle is the reliable MVP the brief requires; drag is
// a progressive enhancement gated on the same two snap points.

export interface SheetProps {
  /** Reduced-motion switch — instant snap instead of `springSheet` (TKT-17 wires the real hook). */
  reduced?: boolean;
}

const PEEK_PX = 96;
const OPEN_VH = 0.8;
const springSheet = { type: "spring" as const, stiffness: 300, damping: 30, mass: 0.9 };

export function Sheet({ reduced = false }: SheetProps) {
  const snap = useRunStore();
  const messageCount = snap.messages.filter((m) => m.from_role !== "office").length;
  const [open, setOpen] = useState(false);
  const y = useMotionValue(0);

  const openHeight = typeof window !== "undefined" ? window.innerHeight * OPEN_VH : 0;

  useEffect(() => {
    const target = open ? 0 : openHeight;
    if (reduced) {
      y.set(target);
    } else {
      const controls = animate(y, target, springSheet);
      return () => controls.stop();
    }
  }, [open, openHeight, reduced, y]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  function handleDragEnd(_: unknown, info: { offset: { y: number }; velocity: { y: number } }) {
    const shouldOpen = info.offset.y < -PEEK_PX / 2 || info.velocity.y < -300;
    const shouldClose = info.offset.y > PEEK_PX / 2 || info.velocity.y > 300;
    if (shouldOpen) setOpen(true);
    else if (shouldClose) setOpen(false);
    // else: snap back to the current state (the effect above re-animates y to it).
  }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            data-testid="transcript-sheet-scrim"
            aria-hidden
            className="fixed inset-0 z-40 bg-[color-mix(in_oklch,var(--neutral-950)_50%,transparent)]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.18 }}
            onClick={() => setOpen(false)}
          />
        )}
      </AnimatePresence>

      <motion.div
        data-testid="transcript-sheet"
        data-state={open ? "open" : "closed"}
        className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-lg border-t border-border bg-surface shadow-lg"
        style={{ height: `${OPEN_VH * 100}vh`, y }}
        drag="y"
        dragConstraints={{ top: 0, bottom: openHeight }}
        dragElastic={0.1}
        onDragEnd={handleDragEnd}
      >
        <button
          type="button"
          data-testid="transcript-sheet-peek"
          aria-label={open ? "Close transcript" : "Open transcript"}
          aria-expanded={open}
          onClick={() => setOpen((prev) => !prev)}
          className="flex h-[96px] min-h-[44px] w-full shrink-0 flex-col items-center justify-center gap-1"
          style={{ paddingBottom: "max(0px, env(safe-area-inset-bottom))" }}
        >
          <span aria-hidden className="h-1 w-10 rounded-full bg-border" />
          <span className="font-manrope text-sm font-semibold text-text">
            Transcript ({messageCount})
          </span>
        </button>

        <div className="min-h-0 flex-1 px-3 pb-3">
          <TranscriptPanel reduced={reduced} className="h-full" />
        </div>
      </motion.div>
    </>
  );
}
