"use client";
import { useRunStore } from "@/lib/client/runStore";

/**
 * Header center-slot pill (Header.tsx's `status` prop). Self-hides on `/` pre-run — the store's
 * runId is null until a run starts — and reflects queued/running(phase)/complete/failed afterward.
 */
export function RunStatusPill() {
  const snap = useRunStore();

  if (!snap.runId) return null;

  let label: string;
  if (snap.queue?.kind === "queued") {
    label = "Queued";
  } else if (snap.queue?.kind === "full") {
    label = "Cubicle is full";
  } else if (snap.terminal && snap.run?.status === "failed") {
    label = "Couldn't finish";
  } else if (snap.terminal && snap.run?.status === "complete") {
    label = "Complete";
  } else if (snap.phase) {
    label = `Running · ${snap.phase}`;
  } else {
    label = "Running";
  }

  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex max-w-full items-center truncate rounded-full border border-border px-2.5 py-1 text-xs text-text-muted"
    >
      {label}
    </span>
  );
}
