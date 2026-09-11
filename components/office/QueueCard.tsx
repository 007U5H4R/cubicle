import type { QueueInfo } from "@/lib/client/runStore";

export interface QueueCardProps {
  queue: QueueInfo;
  onTryAgain: () => void;
  reduced?: boolean;
}

function DotCycle({ reduced }: { reduced: boolean }) {
  return (
    <span aria-hidden className="mb-2 inline-flex items-center gap-1.5">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className={reduced ? "" : "queue-dot-cycle"}
          style={{
            display: "inline-block",
            width: "8px",
            height: "8px",
            borderRadius: "9999px",
            backgroundColor: "var(--brand-500)",
            animationDelay: reduced ? undefined : `${i * 200}ms`,
            opacity: reduced ? 0.6 : undefined,
          }}
        />
      ))}
    </span>
  );
}

/**
 * TKT-15 — the centered card shown over the dimmed desk quad while `snap.queue` is set
 * (Design.md §3.9). Two treatments driven by `queue.kind`: `queued` shows a live ETA + position;
 * `full` shows the honest no-countdown copy and a Try-again re-POST button. Caller owns the 60%
 * scrim + positioning (see Office.tsx / RunView.tsx) so this component only renders the card itself.
 */
export function QueueCard({ queue, onTryAgain, reduced = false }: QueueCardProps) {
  if (!queue) return null;

  return (
    <div
      role="status"
      className="flex max-w-sm flex-col items-center rounded-lg bg-surface p-6 text-center"
      style={{ boxShadow: "var(--shadow-md)" }}
    >
      <DotCycle reduced={reduced} />
      {queue.kind === "queued" ? (
        <>
          <p className="text-base font-semibold text-text">Your office opens in about {queue.eta_s}s</p>
          <p className="mt-1 text-sm text-text-muted">You&apos;re {queue.position} in line.</p>
        </>
      ) : (
        <>
          <p className="text-base font-semibold text-text">Cubicle is full right now</p>
          <p className="mt-1 text-sm text-text-muted">Every desk is busy. Try again in a minute.</p>
          <button
            type="button"
            onClick={onTryAgain}
            className="mt-4 flex h-11 min-w-11 items-center justify-center rounded-md border border-border px-4 text-sm font-semibold text-text"
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
