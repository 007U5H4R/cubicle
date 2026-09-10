import { useSyncExternalStore } from "react";
import type { Envelope, Role } from "@/lib/engine/envelope";
import type { RunState } from "@/lib/engine/state";
import { ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import type { RunStreamEvent } from "./runStream";

// TKT-12 Dispatch A — the client run store. A module-singleton `RunSnapshot`, mutated either by the
// SSE path (`applyEvent`, driven by `/` via `openRunStream`) or the poll path (`startPolling`, GET
// `/api/runs/[id]`), read by React via `useSyncExternalStore`. Every mutation replaces the snapshot
// object wholesale (never mutated in place) so subscribers see the change.

export type ArtifactStatus = "pending" | "streaming" | "done" | "failed";

export interface ClientArtifact {
  status: ArtifactStatus;
  content_md: string;
  grounded: boolean;
  sources: unknown[];
}

export type QueueInfo = { kind: "queued"; position: number; eta_s: number } | { kind: "full" } | null;

export interface RunSnapshot {
  runId: string | null;
  run: {
    id: string;
    idea: string;
    status: string;
    stop_reason: string | null;
    started_at: string | null;
    finished_at: string | null;
    is_shared: boolean;
    share_slug: string | null;
    owner: boolean;
  } | null;
  messages: Envelope[]; // ordered; deduped by id
  artifacts: Record<ArtifactType, ClientArtifact>; // all four keys always present
  phase: "debate" | "deliver" | null;
  thinking: Role | null; // from the latest run.status running hint; null in deliver / when hydrated
  queue: QueueInfo;
  wall_s: number | null;
  tokens: number | null;
  cost_cents: number | null;
  failedPhase: "debate" | "deliver" | null; // set when the run failed, so deskState can pick retry vs no-retry
  terminal: boolean; // run.status ∈ {complete, failed}
  live: boolean; // true while SSE feeds applyEvent; false when hydrated from GET
  notFound: boolean; // GET returned 404
  lastSeq: number; // for the SSE seq guard
}

function emptyArtifacts(): Record<ArtifactType, ClientArtifact> {
  const artifacts = {} as Record<ArtifactType, ClientArtifact>;
  for (const type of ARTIFACT_TYPES) {
    artifacts[type] = { status: "pending", content_md: "", grounded: false, sources: [] };
  }
  return artifacts;
}

const EMPTY: RunSnapshot = Object.freeze({
  runId: null,
  run: null,
  messages: [],
  artifacts: emptyArtifacts(),
  phase: null,
  thinking: null,
  queue: null,
  wall_s: null,
  tokens: null,
  cost_cents: null,
  failedPhase: null,
  terminal: false,
  live: false,
  notFound: false,
  lastSeq: 0,
});

let snapshot: RunSnapshot = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const cb of listeners) cb();
}

function setSnapshot(next: RunSnapshot) {
  snapshot = next;
  emit();
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getSnapshot(): RunSnapshot {
  return snapshot;
}

export function getServerSnapshot(): RunSnapshot {
  return EMPTY;
}

export function useRunStore(): RunSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Resets the snapshot to `EMPTY` for `runId` if it isn't already current — prevents stale
 * cross-run bleed when the module-singleton store is reused for a second run. */
export function initRun(runId: string): void {
  if (snapshot.runId !== runId) {
    setSnapshot({ ...EMPTY, artifacts: emptyArtifacts(), runId });
  }
}

export function reset(): void {
  setSnapshot({ ...EMPTY, artifacts: emptyArtifacts() });
}

type RunStatusPayload =
  | { status: "queued"; position: number; eta_s: number }
  | { status: "full" }
  | { status: "running"; phase: "debate"; thinking: Role }
  | { status: "running"; phase: "deliver" };

/** The SSE path. Sets `live = true`. Applies the seq guard (out-of-order/duplicate frames are
 * dropped), then maps `e.type` exactly per the engine's SSE contract (lib/engine §A4). */
export function applyEvent(e: RunStreamEvent): void {
  if (e.seq <= snapshot.lastSeq) return; // seq guard: ignore out-of-order/duplicate

  const base: RunSnapshot = { ...snapshot, live: true, lastSeq: e.seq };

  switch (e.type) {
    case "run.status": {
      const payload = e.payload as RunStatusPayload;
      if (payload.status === "queued") {
        setSnapshot({ ...base, queue: { kind: "queued", position: payload.position, eta_s: payload.eta_s } });
      } else if (payload.status === "full") {
        setSnapshot({ ...base, queue: { kind: "full" } });
      } else {
        const run = base.run ?? {
          id: base.runId ?? e.run_id,
          idea: "",
          status: "running",
          stop_reason: null,
          started_at: null,
          finished_at: null,
          is_shared: false,
          share_slug: null,
          owner: false,
        };
        setSnapshot({
          ...base,
          queue: null,
          phase: payload.phase,
          thinking: payload.phase === "debate" ? payload.thinking : null,
          run: { ...run, status: "running" },
        });
      }
      break;
    }
    case "message":
    case "steer": {
      const envelope = e.payload as Envelope;
      if (base.messages.some((m) => m.id === envelope.id)) {
        setSnapshot(base);
      } else {
        setSnapshot({ ...base, messages: [...base.messages, envelope] });
      }
      break;
    }
    case "artifact.delta": {
      const { type, text } = e.payload as { type: ArtifactType; text: string };
      const prev = base.artifacts[type];
      setSnapshot({
        ...base,
        artifacts: { ...base.artifacts, [type]: { ...prev, status: "streaming", content_md: prev.content_md + text } },
      });
      break;
    }
    case "artifact.done": {
      const { type, grounded, sources } = e.payload as { type: ArtifactType; grounded: boolean; sources: unknown[] };
      const prev = base.artifacts[type];
      setSnapshot({
        ...base,
        artifacts: { ...base.artifacts, [type]: { ...prev, status: "done", grounded, sources } },
      });
      break;
    }
    case "artifact.failed": {
      const { type } = e.payload as { type: ArtifactType };
      const prev = base.artifacts[type];
      setSnapshot({ ...base, artifacts: { ...base.artifacts, [type]: { ...prev, status: "failed" } } });
      break;
    }
    case "run.done": {
      const { wall_s, tokens, cost_cents } = e.payload as { status: "complete"; wall_s: number; tokens: number; cost_cents: number };
      const run = base.run;
      setSnapshot({
        ...base,
        run: run ? { ...run, status: "complete", finished_at: new Date().toISOString() } : run,
        wall_s,
        tokens,
        cost_cents,
        terminal: true,
        thinking: null,
        phase: null,
      });
      break;
    }
    case "run.error": {
      const { phase, reason } = e.payload as { phase: "debate" | "deliver"; reason: string; message?: string };
      const run = base.run;
      setSnapshot({
        ...base,
        run: run ? { ...run, status: "failed", stop_reason: reason } : run,
        failedPhase: phase,
        terminal: true,
        thinking: null,
      });
      break;
    }
    default:
      setSnapshot(base);
  }
}

/** The GET/refresh path. `live = false`. Maps `RunState` (server shape, `lib/engine/state.ts`) onto
 * the client snapshot — `anon_session_id` is dropped (it isn't in the GET response anyway). */
export function hydrate(state: RunState): void {
  const artifacts = emptyArtifacts();
  for (const type of ARTIFACT_TYPES) {
    const row = state.artifacts[type];
    if (row) artifacts[type] = { status: row.status as ArtifactStatus, content_md: row.content_md, grounded: row.grounded, sources: row.sources };
  }

  const terminal = state.run.status === "complete" || state.run.status === "failed";
  let failedPhase: "debate" | "deliver" | null = null;
  if (state.run.status === "failed") {
    const anyArtifactFailed = ARTIFACT_TYPES.some((type) => artifacts[type].status === "failed");
    failedPhase = anyArtifactFailed ? "deliver" : "debate";
  }

  setSnapshot({
    ...snapshot,
    runId: state.run.id,
    run: {
      id: state.run.id,
      idea: state.run.idea,
      status: state.run.status,
      stop_reason: state.run.stop_reason,
      started_at: state.run.started_at,
      finished_at: state.run.finished_at,
      is_shared: state.run.is_shared,
      share_slug: state.run.share_slug,
      owner: state.run.owner,
    },
    messages: state.messages,
    artifacts,
    phase: null,
    thinking: null,
    queue: null,
    terminal,
    failedPhase,
    live: false,
    notFound: false,
  });
}

/** The refresh/poll path — `GET /api/runs/[id]` every 2s until terminal. Never opens an SSE stream
 * (refresh-after-complete must show no SSE connection, TC-049). Returns a `stop()` that cancels the
 * pending timer and aborts the in-flight fetch. */
export function startPolling(runId: string, fetchImpl: typeof fetch = globalThis.fetch): () => void {
  initRun(runId);
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();

  async function tick() {
    if (stopped) return;
    try {
      const res = await fetchImpl(`/api/runs/${runId}`, { signal: controller.signal });
      if (stopped) return;
      if (res.status === 404) {
        setSnapshot({ ...snapshot, notFound: true });
        return;
      }
      if (res.ok) {
        const state = (await res.json()) as RunState;
        hydrate(state);
        if (snapshot.terminal) return;
      }
      // Non-ok, non-404 responses are treated as transient — retry on the next tick.
    } catch {
      // Swallow transient fetch errors (aborts included) — retry next tick.
    }
    if (!stopped) timer = setTimeout(tick, 2000);
  }

  void tick();

  return function stop() {
    stopped = true;
    controller.abort();
    if (timer) clearTimeout(timer);
  };
}
