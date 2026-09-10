import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Gateway, Source, Usage } from "@/lib/gateway";
import type { EventSink } from "@/lib/events";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import type { AgentOutput } from "./envelope";
import type { OrchestratorDecision } from "./orchestrate";
import type { DebateCfg } from "./debate";
import { runOne } from "./run";

type Row = Record<string, unknown>;
type Table = "runs" | "messages" | "artifacts";

// Real column sets from supabase/migrations/0001_init.sql. insert()/upsert()/update() reject any key
// outside this list, mirroring PostgREST's PGRST204 "Could not find the '<col>' column" error — a
// real `runs`/`messages` schema has no `to` column, only `to_role`, and the in-memory double must
// catch that the same way Supabase would. The `artifacts` set is present because wiring the deliver
// phase into runOne means these tests now persist artifact rows too.
const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
  artifacts: new Set(["run_id", "type", "status", "content_md", "grounded", "sources", "tokens_in", "tokens_out", "created_at", "finished_at"]),
};

function makeDb(seed: { runs: Row[]; messages: Row[]; artifacts?: Row[] }) {
  const state = { runs: [...seed.runs], messages: [...seed.messages], artifacts: [...(seed.artifacts ?? [])] };
  const badKey = (name: Table, patch: Row) => Object.keys(patch).find((k) => !COLUMNS[name].has(k));
  const pgrst204 = (name: Table, col: string) => ({ error: { message: `Could not find the '${col}' column of '${name}' in the schema cache`, code: "PGRST204" } });
  function from(name: Table) {
    const rows = state[name];
    return {
      update(patch: Row) {
        const bad = badKey(name, patch);
        return {
          eq(col: string, val: unknown) { if (bad) return Promise.resolve(pgrst204(name, bad)); const row = rows.find((r) => r[col] === val); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); },
          match(criteria: Row) { if (bad) return Promise.resolve(pgrst204(name, bad)); const row = rows.find((r) => Object.entries(criteria).every(([k, v]) => r[k] === v)); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); },
        };
      },
      insert(row: Row) {
        const bad = badKey(name, row);
        if (bad) return Promise.resolve(pgrst204(name, bad));
        rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      upsert(row: Row) {
        const bad = badKey(name, row);
        if (bad) return Promise.resolve(pgrst204(name, bad));
        const existing = rows.find((r) => r.run_id === row.run_id && r.type === row.type);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      select() {
        return { eq(col: string, val: unknown) { return { single() { const row = rows.find((r) => r[col] === val); return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } }); } }; } };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

const u = (input: number, output: number): Usage => ({ input, output });

/** One scripted streaming attempt for an artifact desk: a delta sequence + done, or a thrown error. */
type StreamAttempt = { deltas: string[]; done: { usage: Usage; sources: Source[] } } | { throw: Error };

/** Default: all four desks succeed once (scan grounded with a source). */
const OK_STREAMS: Record<ArtifactType, StreamAttempt[]> = {
  prd: [{ deltas: ["# PRD\n", "body"], done: { usage: u(100, 40), sources: [] } }],
  scan: [{ deltas: ["# Scan\n", "rivals"], done: { usage: u(200, 60), sources: [{ title: "Acme", url: "https://acme.test" }] } }],
  copy: [{ deltas: ["# Copy\n", "headline"], done: { usage: u(80, 30), sources: [] } }],
  plan: [{ deltas: ["# Plan\n", "slice"], done: { usage: u(90, 35), sources: [] } }],
};

function systemToType(system: string): ArtifactType {
  const t = ARTIFACT_TYPES.find((type) => ROLE_PREFIX[ARTIFACT_ROLE[type]] === system);
  if (!t) throw new Error("stream() called with an unknown system prefix");
  return t;
}

/** Scripted gateway (see debate.test.ts) — a queued sequence of orchestrator decisions and agent
 * envelopes by call kind (so a whole debate is deterministic), plus per-desk streaming scripts for
 * the deliver phase (defaulting to OK_STREAMS). */
function scriptGateway(
  script: { orchestrator?: (OrchestratorDecision | Error)[]; agent?: (AgentOutput | Error)[] },
  overrides: Partial<Gateway> = {},
  streams: Record<ArtifactType, StreamAttempt[]> = OK_STREAMS,
): Gateway {
  const orch = [...(script.orchestrator ?? [])];
  const agent = [...(script.agent ?? [])];
  const chat = (async (kind: "orchestrator" | "agent") => {
    const q = kind === "orchestrator" ? orch : agent;
    const next = q.shift();
    if (next === undefined) throw new Error(`no scripted ${kind} response`);
    if (next instanceof Error) throw next;
    return { data: next, usage: { input: 50_000, output: 2_000 } };
  }) as Gateway["chat"];
  const queues: Record<ArtifactType, StreamAttempt[]> = { prd: [...streams.prd], scan: [...streams.scan], copy: [...streams.copy], plan: [...streams.plan] };
  const stream = ((_kind: "artifact" | "grounded", system: string) => {
    const type = systemToType(system);
    const attempt = queues[type].shift();
    if (!attempt) throw new Error(`no scripted stream attempt for ${type}`);
    return (async function* () {
      if ("throw" in attempt) throw attempt.throw;
      for (const text of attempt.deltas) yield { type: "delta", text } as const;
      yield { type: "done", usage: attempt.done.usage, sources: attempt.done.sources } as const;
    })();
  }) as Gateway["stream"];
  return { chat, stream, ...overrides };
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

const CFG: DebateCfg = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 };
const DELIVER_CFG = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 1_000_000 };
const pmOutput: AgentOutput = { to: "team", act: "propose", subject: "Reminders for solo founders", body: "I think the value is fewer missed follow-ups. Unsure if solo founders will pay monthly." };

/** Every SSE `type` whose payload names the given artifact (delta/done/failed carry `type`). */
const artifactEventTypes = (events: { type: string; payload: unknown }[], artifact: ArtifactType) =>
  events.filter((e) => (e.payload as { type?: string }).type === artifact).map((e) => e.type);

describe("runOne", () => {
  it("runs the debate, delivers the four artifacts, completes the run, and streams the full sequence", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "A reminder app for solo founders", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    let clock = 1000;
    // A minimal debate: orchestrator picks pm, then done. Deliver uses the default OK_STREAMS.
    const gateway = scriptGateway({ orchestrator: [{ next: "pm", brief: "open it" }, { next: "done", brief: "wrap" }], agent: [pmOutput] });
    await runOne("r1", sse, { db, gateway, sink: stubSink(), now: () => clock++ }, CFG, DELIVER_CFG);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ seq: 1, from_role: "pm", hops: 0, to_role: "team", act: "propose" });
    // The messages table has no `to` column (only `to_role`) — inserting the raw envelope (which
    // carries AgentOutput's `to`) would be rejected by real Supabase/PostgREST with PGRST204. The
    // in-memory double's insert() enforces the same column allowlist, so this guards that regression.
    expect(state.messages[0]).not.toHaveProperty("to");

    // All four artifacts persisted done; scan grounded with its source.
    expect(state.artifacts).toHaveLength(4);
    for (const type of ARTIFACT_TYPES) expect(state.artifacts.find((a) => a.type === type)?.status).toBe("done");
    expect(state.artifacts.find((a) => a.type === "scan")).toMatchObject({ grounded: true, sources: [{ title: "Acme", url: "https://acme.test" }] });

    // Run completed with debate+deliver tokens summed and a non-zero cost.
    expect(state.runs[0]).toMatchObject({ status: "complete", stop_reason: "done" });
    expect(state.runs[0].tokens_in).toBeGreaterThan(0);
    expect(state.runs[0].tokens_out).toBeGreaterThan(0);
    expect(state.runs[0].cost_cents).toBeGreaterThan(0);

    // SSE: debate status+message, then the deliver phase status, the four desks' delta…done, and a
    // single terminal run.done. The four desks fan out in parallel, so only the boundaries are fixed.
    const types = sse.events.map((e) => e.type);
    expect(types[0]).toBe("run.status");
    expect(sse.events[0]).toMatchObject({ type: "run.status", payload: { status: "running", phase: "debate", thinking: "pm" } });
    expect(types[1]).toBe("message");
    expect(sse.events[2]).toEqual({ type: "run.status", payload: { status: "running", phase: "deliver" } });
    expect(types.at(-1)).toBe("run.done");
    expect(types.filter((t) => t === "run.done")).toHaveLength(1);
    expect(sse.events.at(-1)).toMatchObject({ type: "run.done", payload: { status: "complete" } });
    for (const type of ARTIFACT_TYPES) {
      const desk = artifactEventTypes(sse.events, type);
      expect(desk.at(-1)).toBe("artifact.done");
      expect(desk.slice(0, -1).every((t) => t === "artifact.delta")).toBe(true);
      expect(desk).toContain("artifact.delta");
    }
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("marks the run failed and emits run.error once when the model is unavailable for the whole debate", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    // Every gateway call throws: the orchestrator falls back to fixed order, every agent turn is
    // skipped, and the stall breaker fails the run rather than looping forever.
    const failingChat = (async () => { throw new Error("model unavailable"); }) as Gateway["chat"];
    const gateway = scriptGateway({}, { chat: failingChat });
    await runOne("r1", sse, { db, gateway, sink, now: () => 0 }, CFG, DELIVER_CFG);

    expect(state.messages).toHaveLength(0);
    expect(state.artifacts).toHaveLength(0); // deliver never ran — the debate failed first.
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(String(state.runs[0].error)).toMatch(/stalled/);
    expect(sse.events.at(-1)).toMatchObject({ type: "run.error", payload: { phase: "debate", reason: "model_error" } });
    expect(sink.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "run_failed", run_id: "r1" }));
    expect(sink.insert).toHaveBeenCalledTimes(1); // exactly one run_failed, no debate_completed
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("fails the run at phase:deliver (exactly one run_failed) when the debate succeeds but a desk fails twice", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    // Debate succeeds (pm then done); the plan desk throws on both attempts → deliver returns failed
    // with model_error, and finalizeDeliver — not the run.ts catch — emits the single run_failed.
    const streams: Record<ArtifactType, StreamAttempt[]> = {
      ...OK_STREAMS,
      plan: [{ throw: new Error("plan model error") }, { throw: new Error("plan model error again") }],
    };
    const gateway = scriptGateway({ orchestrator: [{ next: "pm", brief: "open it" }, { next: "done", brief: "wrap" }], agent: [pmOutput] }, {}, streams);
    let clock = 0;
    await runOne("r1", sse, { db, gateway, sink, now: () => clock++ }, CFG, DELIVER_CFG);

    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(String(state.runs[0].error)).toContain("deliver failed: model_error");
    // Tokens/cost persisted even on a failed deliver (the debate + three good desks spent them).
    expect(state.runs[0].tokens_in).toBeGreaterThan(0);
    expect(state.runs[0].cost_cents).toBeGreaterThan(0);
    expect(state.artifacts.find((a) => a.type === "plan")?.status).toBe("failed");

    expect(sse.events.at(-1)).toMatchObject({ type: "run.error", payload: { phase: "deliver", reason: "model_error" } });
    const runFailed = (sink.insert as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as { name: string }).name === "run_failed");
    expect(runFailed).toHaveLength(1); // exactly one run_failed, labelled deliver
    expect(runFailed[0][0]).toMatchObject({ name: "run_failed", run_id: "r1", props: { phase: "deliver", reason: "model_error" } });
    expect(sse.close).toHaveBeenCalledOnce();
  });
});
