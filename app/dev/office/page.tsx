"use client";
import { useEffect, useRef, useState } from "react";
import { Desk, type Role } from "@/components/office/Desk";
import { MessageTravel } from "@/components/office/MessageTravel";
import { QueueCard } from "@/components/office/QueueCard";
import { RunErrorBanner } from "@/components/office/RunErrorBanner";
import { TranscriptPanel } from "@/components/transcript/TranscriptPanel";
import { Pack } from "@/components/pack/Pack";
import { applyEvent, reset, useRunStore } from "@/lib/client/runStore";
import { deriveDesks } from "@/lib/client/deskState";
import type { RunStreamEvent } from "@/lib/client/runStream";
import fixture from "@/tests/replay/fixtures/run-001.json";

const ROLES: Role[] = ["pm", "researcher", "designer", "developer"];
const EVENTS = fixture as RunStreamEvent[];

/**
 * TC-048 — dev-only fixture stepper. Drives the client run store through `run-001.json` event by
 * event so every desk state is reachable on demand, plus two synthetic failure injections (the
 * happy-path fixture never fails) to exhibit the `failed` treatments. Verification tool, not
 * production UI — kept functional, not polished.
 *
 * `applyEvent`/`reset` are store mutations (side effects) and must only run in a handler/effect
 * body, never inside a `setState` updater — React runs updaters during render, so a mutation there
 * causes a "Cannot update a component while rendering a different component" violation (the store's
 * other subscriber, RunStatusPill, would update mid-render). `idxRef` tracks the current index for
 * handlers to read synchronously (including the Play interval, so it never goes stale); `setIndex`
 * only ever mirrors it for display.
 */
export default function DevOfficePage() {
  const snap = useRunStore();
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const idxRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  function advance() {
    if (idxRef.current >= EVENTS.length) return;
    applyEvent(EVENTS[idxRef.current]);
    idxRef.current += 1;
    setIndex(idxRef.current);
  }

  function step() {
    advance();
  }

  function handleReset() {
    setPlaying(false);
    reset();
    idxRef.current = 0;
    setIndex(0);
  }

  useEffect(() => {
    if (!playing) return;
    timerRef.current = setInterval(() => {
      if (idxRef.current >= EVENTS.length) {
        setPlaying(false);
        return;
      }
      advance();
    }, 1000);
    return () => clearInterval(timerRef.current);
  }, [playing]);

  function injectArtifactFailedCopy() {
    setPlaying(false);
    const nextSeq = snap.lastSeq + 1;
    applyEvent({ run_id: "run-001", seq: nextSeq, type: "artifact.failed", payload: { type: "copy" } });
    applyEvent({
      run_id: "run-001",
      seq: nextSeq + 1,
      type: "run.error",
      payload: { phase: "deliver", reason: "model_error" },
    });
  }

  function injectQueued() {
    setPlaying(false);
    const nextSeq = snap.lastSeq + 1;
    applyEvent({ run_id: "run-001", seq: nextSeq, type: "run.status", payload: { status: "queued", position: 3, eta_s: 20 } });
  }

  function injectFull() {
    setPlaying(false);
    const nextSeq = snap.lastSeq + 1;
    applyEvent({ run_id: "run-001", seq: nextSeq, type: "run.status", payload: { status: "full" } });
  }

  function injectPhase1Failure() {
    setPlaying(false);
    reset();
    idxRef.current = 0;
    setIndex(0);
    applyEvent({ run_id: "run-001", seq: 1, type: "run.status", payload: { status: "running", phase: "debate", thinking: "pm" } });
    applyEvent({
      run_id: "run-001",
      seq: 2,
      type: "message",
      payload: {
        id: "dev-1",
        run_id: "run-001",
        seq: 1,
        from_role: "pm",
        to: "team",
        to_role: "team",
        act: "propose",
        subject: "Opening",
        body: "Opening proposal for the dev stepper.",
        reply_to: null,
        hops: 0,
        brief: null,
        created_at: new Date(0).toISOString(),
      },
    });
    applyEvent({ run_id: "run-001", seq: 3, type: "run.error", payload: { phase: "debate", reason: "model_error" } });
  }

  const desks = deriveDesks(snap, true);
  const currentEvent = index < EVENTS.length ? EVENTS[index] : null;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-[var(--gutter)] py-12">
      <h1 className="text-2xl font-bold text-text">/dev/office — desk state stepper (TC-048)</h1>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={step} disabled={index >= EVENTS.length} className="h-11 rounded-md border border-border px-4 text-sm">
          Step
        </button>
        <button type="button" onClick={() => setPlaying((p) => !p)} className="h-11 rounded-md border border-border px-4 text-sm">
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={handleReset} className="h-11 rounded-md border border-border px-4 text-sm">
          Reset
        </button>
        <button type="button" onClick={injectArtifactFailedCopy} className="h-11 rounded-md border border-act-objection px-4 text-sm text-act-objection">
          Inject artifact.failed (copy)
        </button>
        <button type="button" onClick={injectPhase1Failure} className="h-11 rounded-md border border-act-objection px-4 text-sm text-act-objection">
          Inject Phase-1 failure
        </button>
        <button type="button" onClick={injectQueued} className="h-11 rounded-md border border-border px-4 text-sm">
          Inject queued
        </button>
        <button type="button" onClick={injectFull} className="h-11 rounded-md border border-border px-4 text-sm">
          Inject full
        </button>
      </div>

      <p className="text-sm text-text-muted">
        Event {Math.min(index, EVENTS.length)}/{EVENTS.length}
        {currentEvent ? ` — next: ${currentEvent.type}` : " — fixture exhausted"}
      </p>

      {snap.terminal && snap.run?.status === "failed" && <RunErrorBanner />}

      <div className="relative">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {ROLES.map((role) => (
            <Desk key={role} role={role} {...desks[role]} onRetry={desks[role].retryable ? () => {} : undefined} />
          ))}
        </div>

        {snap.queue && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center rounded-lg p-4"
            style={{ backgroundColor: "color-mix(in oklch, var(--neutral-950) 60%, transparent)" }}
          >
            <QueueCard queue={snap.queue} onTryAgain={() => {}} />
          </div>
        )}
      </div>

      <Pack />

      <TranscriptPanel className="h-[420px] min-h-0 rounded-lg border border-border bg-surface p-3" />
      <MessageTravel />
    </main>
  );
}
