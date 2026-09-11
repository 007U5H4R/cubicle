import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Envelope } from "@/lib/engine/envelope";
import type { RunState } from "@/lib/engine/state";
import type { RunStreamEvent } from "./runStream";
import {
  applyEvent,
  getSnapshot,
  hydrate,
  initRun,
  reset,
  startPolling,
} from "./runStore";

// TKT-12 Dispatch A — pure-module tests for the run store (no jsdom needed; this is a plain module).

const RUN_ID = "r1";

function evt(seq: number, type: string, payload: unknown): RunStreamEvent {
  return { run_id: RUN_ID, seq, type, payload };
}

function envelope(overrides: Partial<Envelope>): Envelope {
  return {
    id: "m1",
    run_id: RUN_ID,
    seq: 1,
    from_role: "pm",
    to: "team",
    to_role: "team",
    act: "propose",
    subject: "s",
    body: "b",
    reply_to: null,
    hops: 0,
    brief: null,
    created_at: "2020-01-01T00:00:00.000Z",
    ...overrides,
  } as Envelope;
}

beforeEach(() => {
  reset();
  initRun(RUN_ID);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("applyEvent", () => {
  it("ignores out-of-order / duplicate seqs (seq guard)", () => {
    applyEvent(evt(5, "run.status", { status: "running", phase: "debate", thinking: "pm" }));
    expect(getSnapshot().lastSeq).toBe(5);
    applyEvent(evt(3, "run.status", { status: "running", phase: "debate", thinking: "designer" }));
    // stale seq=3 is dropped: thinking stays "pm", lastSeq stays 5
    expect(getSnapshot().thinking).toBe("pm");
    expect(getSnapshot().lastSeq).toBe(5);
    applyEvent(evt(5, "run.status", { status: "running", phase: "debate", thinking: "designer" }));
    // duplicate seq=5 is also dropped
    expect(getSnapshot().thinking).toBe("pm");
  });

  it("dedupes messages by id", () => {
    const m = envelope({ id: "dup-1", seq: 1 });
    applyEvent(evt(1, "message", m));
    applyEvent(evt(2, "message", m));
    expect(getSnapshot().messages).toHaveLength(1);
  });

  it("applies artifact.delta -> streaming, artifact.done -> done+grounded+sources", () => {
    applyEvent(evt(1, "artifact.delta", { type: "prd", text: "hello " }));
    expect(getSnapshot().artifacts.prd).toMatchObject({ status: "streaming", content_md: "hello " });
    applyEvent(evt(2, "artifact.delta", { type: "prd", text: "world" }));
    expect(getSnapshot().artifacts.prd.content_md).toBe("hello world");
    applyEvent(evt(3, "artifact.done", { type: "prd", grounded: true, sources: [{ title: "t", url: "u" }] }));
    expect(getSnapshot().artifacts.prd).toMatchObject({ status: "done", grounded: true, sources: [{ title: "t", url: "u" }] });
  });

  it("applies artifact.failed -> failed", () => {
    applyEvent(evt(1, "artifact.failed", { type: "scan" }));
    expect(getSnapshot().artifacts.scan.status).toBe("failed");
  });

  it("run.done -> complete + terminal + totals", () => {
    applyEvent(evt(1, "run.status", { status: "running", phase: "deliver" }));
    applyEvent(evt(2, "run.done", { status: "complete", wall_s: 12, tokens: 500, cost_cents: 7 }));
    const snap = getSnapshot();
    expect(snap.run?.status).toBe("complete");
    expect(snap.terminal).toBe(true);
    expect(snap.thinking).toBeNull();
    expect(snap.phase).toBeNull();
    expect(snap.wall_s).toBe(12);
    expect(snap.tokens).toBe(500);
    expect(snap.cost_cents).toBe(7);
  });

  it("run.error -> failed + failedPhase + terminal", () => {
    applyEvent(evt(1, "run.status", { status: "running", phase: "debate", thinking: "pm" }));
    applyEvent(evt(2, "run.error", { phase: "debate", reason: "model_error", message: "boom" }));
    const snap = getSnapshot();
    expect(snap.run?.status).toBe("failed");
    expect(snap.run?.stop_reason).toBe("model_error");
    expect(snap.failedPhase).toBe("debate");
    expect(snap.terminal).toBe(true);
    expect(snap.thinking).toBeNull();
  });

  it("sets live=true on any applied event", () => {
    expect(getSnapshot().live).toBe(false);
    applyEvent(evt(1, "run.status", { status: "queued", position: 2, eta_s: 30 }));
    expect(getSnapshot().live).toBe(true);
    expect(getSnapshot().queue).toEqual({ kind: "queued", position: 2, eta_s: 30 });
  });

  it("run.status full -> queue full", () => {
    applyEvent(evt(1, "run.status", { status: "full" }));
    expect(getSnapshot().queue).toEqual({ kind: "full" });
  });

  // QA-001 scar (app/dev/office/page.tsx's injectArtifactFailedCopy no-op before any Step): on a
  // fresh store (snap.run still null, e.g. no run.status applied yet), artifact.failed and run.error
  // must not throw. run.error's `run` stays null (it only mutates an existing run object) — terminal
  // and failedPhase still flip, but nothing downstream can read run.status === "failed" off a null
  // run, so no run-level UI (e.g. RunErrorBanner) can render. The dev page works around this by
  // seeding a run.status event first when snap.run is null — asserted here too.
  it("artifact.failed + run.error on a fresh store (no run seeded) doesn't throw and stays sane", () => {
    expect(getSnapshot().run).toBeNull();
    expect(() => {
      applyEvent(evt(1, "artifact.failed", { type: "copy" }));
      applyEvent(evt(2, "run.error", { phase: "deliver", reason: "model_error" }));
    }).not.toThrow();
    const snap = getSnapshot();
    expect(snap.artifacts.copy.status).toBe("failed");
    expect(snap.terminal).toBe(true);
    expect(snap.failedPhase).toBe("deliver");
    expect(snap.run).toBeNull(); // no run object to update -> stays null, confirming the no-op
  });

  it("seeding run.status first (the dev-page fix) makes the same injection visible as a failed run", () => {
    applyEvent(evt(1, "run.status", { status: "running", phase: "deliver" }));
    applyEvent(evt(2, "artifact.failed", { type: "copy" }));
    applyEvent(evt(3, "run.error", { phase: "deliver", reason: "model_error" }));
    const snap = getSnapshot();
    expect(snap.run?.status).toBe("failed");
    expect(snap.terminal).toBe(true);
  });
});

describe("hydrate", () => {
  function runState(overrides: Partial<RunState["run"]> = {}): RunState {
    return {
      run: {
        id: RUN_ID,
        idea: "an idea",
        status: "complete",
        stop_reason: "done",
        started_at: "2020-01-01T00:00:00.000Z",
        finished_at: "2020-01-01T00:01:00.000Z",
        is_shared: false,
        share_slug: null,
        owner: true,
        anon_session_id: "s1",
        ...overrides,
      },
      messages: [envelope({ id: "m1" })],
      artifacts: {
        prd: { status: "done", content_md: "# PRD", grounded: false, sources: [] },
      },
    };
  }

  it("maps RunState onto the snapshot, sets live=false, terminal true for complete", () => {
    hydrate(runState());
    const snap = getSnapshot();
    expect(snap.live).toBe(false);
    expect(snap.terminal).toBe(true);
    expect(snap.run).toMatchObject({ id: RUN_ID, idea: "an idea", status: "complete", owner: true });
    expect(snap.run).not.toHaveProperty("anon_session_id");
    expect(snap.messages).toHaveLength(1);
    expect(snap.artifacts.prd).toMatchObject({ status: "done", content_md: "# PRD" });
    expect(snap.artifacts.scan.status).toBe("pending"); // missing types stay pending
    expect(snap.failedPhase).toBeNull();
    expect(snap.phase).toBeNull();
    expect(snap.thinking).toBeNull();
  });

  it("failedPhase = deliver when status failed and an artifact failed", () => {
    hydrate({
      ...runState({ status: "failed", stop_reason: "model_error" }),
      artifacts: { plan: { status: "failed", content_md: "", grounded: false, sources: [] } },
    });
    const snap = getSnapshot();
    expect(snap.terminal).toBe(true);
    expect(snap.failedPhase).toBe("deliver");
  });

  it("failedPhase = debate when status failed and no artifact failed", () => {
    hydrate({ ...runState({ status: "failed", stop_reason: "model_error" }), artifacts: {} });
    expect(getSnapshot().failedPhase).toBe("debate");
  });
});

describe("startPolling", () => {
  it("polls until terminal, then stops, and never opens an SSE connection", async () => {
    const nonTerminal: RunState = {
      run: { id: RUN_ID, idea: "i", status: "running", stop_reason: null, started_at: null, finished_at: null, is_shared: false, share_slug: null, owner: false, anon_session_id: "s1" },
      messages: [],
      artifacts: {},
    };
    const terminal: RunState = { ...nonTerminal, run: { ...nonTerminal.run, status: "complete", stop_reason: "done" } };

    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      const body = call === 1 ? nonTerminal : terminal;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    // Guard: EventSource / SSE must never be constructed by the poll path.
    const EventSourceSpy = vi.fn();
    vi.stubGlobal("EventSource", EventSourceSpy);

    vi.useFakeTimers();
    const stop = startPolling(RUN_ID, fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0); // let the first tick's promise resolve
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(getSnapshot().terminal).toBe(false);

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(getSnapshot().terminal).toBe(true);

    // No further polling after terminal.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    expect(EventSourceSpy).not.toHaveBeenCalled();
    stop();
    vi.unstubAllGlobals();
  });

  it("sets notFound on a 404 and stops polling", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));
    vi.useFakeTimers();
    const stop = startPolling(RUN_ID, fetchImpl as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(0);
    expect(getSnapshot().notFound).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    stop();
  });
});
