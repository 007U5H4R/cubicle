"use client";
import { ArtifactCard } from "./ArtifactCard";
import { useRunStore } from "@/lib/client/runStore";
import { ARTIFACT_TYPES } from "@/lib/prompts/headings";

// TKT-14 Dispatch B — the artifact pack: the four cards in §10 order, a shared footer, and inert
// Save/Share placeholders (wired in TKT-18/19). Renders nothing during debate — Phase 2 (deliver)
// is the pack's entire reason to exist.

/** True once Phase 2 has started (or is done): `phase === "deliver"`, or — since `phase` clears back
 * to `null` on `run.done`/`run.error` (see runStore's `run.done`/`run.error` handlers) — any
 * artifact having left `pending` also counts, so the pack stays mounted through to completion. */
function packVisible(snap: ReturnType<typeof useRunStore>): boolean {
  if (snap.phase === "deliver") return true;
  return ARTIFACT_TYPES.some((type) => snap.artifacts[type].status !== "pending");
}

export function Pack() {
  const snap = useRunStore();

  if (!packVisible(snap)) return null;

  const footerVisible = snap.terminal && snap.run?.status === "complete";
  const footerHref = snap.run?.share_slug ? `/?ref=${snap.run.share_slug}` : "/";

  return (
    <div className="flex flex-col gap-4">
      {ARTIFACT_TYPES.map((type) => (
        <ArtifactCard key={type} type={type} />
      ))}

      {footerVisible && (
        <p className="text-center text-xs text-text-muted">
          <a href={footerHref} className="underline underline-offset-2">
            Made in Cubicle — run your own
          </a>
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled
          title="coming soon"
          className="flex h-11 flex-1 items-center justify-center rounded-md border border-border text-sm text-text-muted disabled:opacity-60"
        >
          Save
        </button>
        <button
          type="button"
          disabled
          title="coming soon"
          className="flex h-11 flex-1 items-center justify-center rounded-md border border-border text-sm text-text-muted disabled:opacity-60"
        >
          Share
        </button>
      </div>
    </div>
  );
}
