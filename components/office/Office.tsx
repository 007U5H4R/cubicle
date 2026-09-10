"use client";
import { useCallback, useState } from "react";
import { Desk, type Role } from "./Desk";
import { IdeaBox, type IdeaBoxError } from "./IdeaBox";
import { openRunStream } from "@/lib/client/runStream";

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
 * The desk quad never unmounts across that transition — only the idea-box region swaps for a
 * "started" placeholder (the real live-run UI is TKT-12), and the URL moves to /run/[id] via
 * history.pushState (not router.push, which would remount the tree).
 */
export function Office() {
  const [idea, setIdea] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<IdeaBoxError | null>(null);

  const handleSubmit = useCallback(() => {
    setError(null);
    setPhase("starting");
    openRunStream(
      { idea },
      {
        onOpen(runId) {
          window.history.pushState(null, "", `/run/${runId}`);
          setPhase("started");
        },
        onError(status, body) {
          setPhase("idle");
          setError(errorFromResponse(status, body));
        },
      },
    );
  }, [idea]);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-[var(--gutter)] py-12">
      <h1 className="text-3xl font-bold text-text">Your first team fits in a cubicle.</h1>

      <div className="transition-opacity duration-[240ms] ease-[var(--ease-in-out)]">
        {phase === "started" ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-sm text-text-muted">
            Starting your office…
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
        {ROLES.map((role) => (
          <Desk key={role} role={role} state="idle" />
        ))}
      </div>
    </main>
  );
}
