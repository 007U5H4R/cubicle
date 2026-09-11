"use client";
import { useEffect, useState } from "react";
import { Desk, type Role } from "./Desk";
import { MessageTravel } from "./MessageTravel";
import { QueueCard } from "./QueueCard";
import { RunErrorBanner } from "./RunErrorBanner";
import { applyEvent, useRunStore, initRun, startPolling } from "@/lib/client/runStore";
import { deriveDesks } from "@/lib/client/deskState";
import { openRunStream } from "@/lib/client/runStream";
import type { ArtifactType } from "@/lib/prompts/headings";
import { ARTIFACT_ROLE } from "@/lib/prompts/headings";
import { TranscriptPanel } from "@/components/transcript/TranscriptPanel";
import { Sheet } from "@/components/transcript/Sheet";
import { Pack } from "@/components/pack/Pack";
import { useIsMobile } from "@/lib/client/useIsMobile";

const ROLES: Role[] = ["pm", "researcher", "designer", "developer"];

function artifactOf(role: Role): ArtifactType {
  return (Object.keys(ARTIFACT_ROLE) as ArtifactType[]).find((type) => ARTIFACT_ROLE[type] === role)!;
}

/**
 * The `/run/[id]` view. Hydrates + polls `GET /api/runs/[id]` every 2s until terminal (never opens
 * an SSE stream — TC-049) and renders the same desk quad as `/` from the shared client run store.
 * Retry re-POSTs the per-artifact retry endpoint; polling then picks up the resulting change.
 */
export function RunView({ id }: { id: string }) {
  const snap = useRunStore();
  const [retrying, setRetrying] = useState<Role | null>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    initRun(id);
    const stop = startPolling(id);
    return stop;
  }, [id]);

  if (snap.notFound) {
    return (
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-[var(--gutter)] py-12">
        <p className="text-sm text-text-muted">Run not found.</p>
      </main>
    );
  }

  const desks = deriveDesks(snap, snap.live);
  const ideaRecap = snap.run?.idea ?? "";

  async function handleRetry(role: Role) {
    setRetrying(role);
    try {
      await fetch(`/api/runs/${id}/artifact/${artifactOf(role)}/retry`, { method: "POST" });
    } finally {
      setRetrying(null);
    }
  }

  // A queue-full happens at slot-acquisition time before a run row exists, so a Try-again re-POSTs
  // a fresh run with the same idea (the server owns allowance) — same path as Office's handleSubmit.
  function handleTryAgain() {
    openRunStream(
      { idea: ideaRecap },
      {
        onOpen(runId) {
          initRun(runId);
          window.history.pushState(null, "", `/run/${runId}`);
        },
        onEvent(e) {
          applyEvent(e);
        },
      },
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 px-[var(--gutter)] py-12 md:flex-row md:items-start">
      <div className="flex w-full min-w-0 flex-col gap-8 md:max-w-3xl">
        {ideaRecap && (
          <div className="truncate rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            {ideaRecap}
          </div>
        )}

        {snap.terminal && snap.run?.status === "failed" && <RunErrorBanner />}

        <div className="relative">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {ROLES.map((role) => {
              const derived = desks[role];
              const onRetry =
                derived.state === "failed" && derived.retryable && retrying !== role
                  ? () => handleRetry(role)
                  : undefined;
              return <Desk key={role} role={role} {...derived} onRetry={onRetry} />;
            })}
          </div>

          {snap.queue && (
            <div
              className="absolute inset-0 z-10 flex items-center justify-center rounded-lg p-4"
              style={{ backgroundColor: "color-mix(in oklch, var(--neutral-950) 60%, transparent)" }}
            >
              <QueueCard queue={snap.queue} onTryAgain={handleTryAgain} />
            </div>
          )}
        </div>

        <Pack />
      </div>

      {isMobile ? (
        <Sheet />
      ) : (
        <TranscriptPanel
          className="h-[420px] min-h-0 rounded-lg border border-border bg-surface p-3 md:sticky md:top-12 md:h-[calc(100vh-6rem)] md:flex-1"
        />
      )}
      <MessageTravel />
    </main>
  );
}
