"use client";
import { useCallback, useState } from "react";
import { Desk, type Role } from "./Desk";
import { IdeaBox, type IdeaBoxError } from "./IdeaBox";
import { MessageTravel } from "./MessageTravel";
import { openRunStream } from "@/lib/client/runStream";
import { applyEvent, initRun, useRunStore } from "@/lib/client/runStore";
import { deriveDesks } from "@/lib/client/deskState";
import { TranscriptPanel } from "@/components/transcript/TranscriptPanel";

const ROLES: Role[] = ["pm", "researcher", "designer", "developer"];

type Phase = "idle" | "starting" | "started";

function errorFromResponse(status: number, body: unknown): IdeaBoxError {
  const b = (body ?? {}) as { error?: string; message?: string; trigger?: string };
  if (status === 403 && b.trigger === "limit") {
    return { kind: "limit", message: "You've used your free run — sign in to run more." };
  }
  if (status === 400 && b.error === "idea_invalid" && b.message) {
    return { kind: "validation", message: b.message };
  }
  if (status >= 500 || status === 0) {
    return { kind: "server", message: "Our office is down, try in a few minutes." };
  }
  // Any other 4xx (e.g. no_session) — same generic server-down copy; there's nothing more
  // actionable to tell the user near the idea box.
  return { kind: "server", message: "Our office is down, try in a few minutes." };
}

/**
 * Owns the "/" route: the idea box + the desk quad, and the in-place transition to a started run.
 * The desk quad never unmounts across that transition — the same keyed `<Desk key={role}>` elements
 * stay in the same JSX position; only their props change, driven by the client run store
 * (`applyEvent`/`deriveDesks`) once the SSE stream opens. Only the idea-box region swaps for the
 * idea recap line — the full artifact-pack + transcript are later tickets.
 */
export function Office() {
  const [idea, setIdea] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<IdeaBoxError | null>(null);
  const snap = useRunStore();

  const handleSubmit = useCallback(() => {
    setError(null);
    setPhase("starting");
    openRunStream(
      { idea },
      {
        onOpen(runId) {
          initRun(runId);
          window.history.pushState(null, "", `/run/${runId}`);
          setPhase("started");
        },
        onEvent(e) {
          applyEvent(e);
        },
        onError(status, body) {
          setPhase("idle");
          setError(errorFromResponse(status, body));
        },
      },
    );
  }, [idea]);

  const desks = phase === "started" ? deriveDesks(snap, snap.live) : null;
  const ideaRecap = snap.run?.idea || idea;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-[var(--gutter)] py-12">
      <h1 className="text-3xl font-bold text-text">Your first team fits in a cubicle.</h1>

      <div className="transition-opacity duration-[240ms] ease-[var(--ease-in-out)]">
        {phase === "started" ? (
          <div className="truncate rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            {ideaRecap}
          </div>
        ) : (
          <IdeaBox
            value={idea}
            onChange={setIdea}
            onSubmit={handleSubmit}
            disabled={phase === "starting"}
            error={error}
          />
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {ROLES.map((role) =>
          desks ? (
            <Desk key={role} role={role} {...desks[role]} />
          ) : (
            <Desk key={role} role={role} state="idle" />
          ),
        )}
      </div>

      {phase === "started" && (
        <>
          {/* Single-column stack under the quad (TKT-13 brief) — the two-column desktop layout is
              RunView's; full parity here would risk the quad-continuity invariant above and is
              deferred to TKT-16/Design Critique. */}
          <TranscriptPanel className="h-[420px] min-h-0 rounded-lg border border-border bg-surface p-3" />
          <MessageTravel />
        </>
      )}
    </main>
  );
}
