import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Gateway } from "@/lib/gateway";
import type { EventSink } from "@/lib/events";
import type { AgentOutput } from "./envelope";
import type { OrchestratorDecision } from "./orchestrate";
import type { DebateCfg } from "./debate";
import { runOne } from "./run";

type Row = Record<string, unknown>;
type Table = "runs" | "messages";

// Real column sets from supabase/migrations/0001_init.sql. insert() rejects any key outside this
// list, mirroring PostgREST's PGRST204 "Could not find the '<col>' column" error — a real
// `runs`/`messages` schema has no `to` column, only `to_role`, and the in-memory double must catch
// that the same way Supabase would.
const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
};

function makeDb(seed: { runs: Row[]; messages: Row[] }) {
  const state = { runs: [...seed.runs], messages: [...seed.messages] };
  function from(name: Table) {
    const rows = state[name];
    return {
      update(patch: Row) {
        return { eq(col: string, val: unknown) { const row = rows.find((r) => r[col] === val); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); } };
      },
      insert(row: Row) {
        const unknownKey = Object.keys(row).find((k) => !COLUMNS[name].has(k));
        if (unknownKey) return Promise.resolve({ error: { message: `Could not find the '${unknownKey}' column of '${name}' in the schema cache`, code: "PGRST204" } });
        rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      select() {
        return { eq(col: string, val: unknown) { return { single() { const row = rows.find((r) => r[col] === val); return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } }); } }; } };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

/** Scripted gateway (see debate.test.ts) — a queued sequence of orchestrator decisions and agent
 * envelopes by call kind, so a whole debate is deterministic. */
function scriptGateway(script: { orchestrator?: (OrchestratorDecision | Error)[]; agent?: (AgentOutput | Error)[] }, overrides: Partial<Gateway> = {}): Gateway {
  const orch = [...(script.orchestrator ?? [])];
  const agent = [...(script.agent ?? [])];
  const chat = (async (kind: "orchestrator" | "agent") => {
    const q = kind === "orchestrator" ? orch : agent;
    const next = q.shift();
    if (next === undefined) throw new Error(`no scripted ${kind} response`);
    if (next instanceof Error) throw next;
    return { data: next, usage: { input: 50_000, output: 2_000 } };
  }) as Gateway["chat"];
  const stream = (async function* () {}) as Gateway["stream"];
  return { chat, stream, ...overrides };
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

const CFG: DebateCfg = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 };
const pmOutput: AgentOutput = { to: "team", act: "propose", subject: "Reminders for solo founders", body: "I think the value is fewer missed follow-ups. Unsure if solo founders will pay monthly." };

describe("runOne", () => {
  it("runs the debate, completes the run, and streams status -> message -> done", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "A reminder app for solo founders", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    let clock = 1000;
    // A minimal debate: orchestrator picks pm, then done.
    const gateway = scriptGateway({ orchestrator: [{ next: "pm", brief: "open it" }, { next: "done", brief: "wrap" }], agent: [pmOutput] });
    await runOne("r1", sse, { db, gateway, sink: stubSink(), now: () => clock++ }, CFG);

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ seq: 1, from_role: "pm", hops: 0, to_role: "team", act: "propose" });
    // The messages table has no `to` column (only `to_role`) — inserting the raw envelope (which
    // carries AgentOutput's `to`) would be rejected by real Supabase/PostgREST with PGRST204. The
    // in-memory double's insert() enforces the same column allowlist, so this guards that regression.
    expect(state.messages[0]).not.toHaveProperty("to");
    expect(state.runs[0]).toMatchObject({ status: "complete", stop_reason: "done" });
    expect(state.runs[0].tokens_in).toBeGreaterThan(0);
    expect(state.runs[0].tokens_out).toBeGreaterThan(0);
    expect(state.runs[0].cost_cents).toBeGreaterThan(0);
    expect(sse.events.map((e) => e.type)).toEqual(["run.status", "message", "run.done"]);
    expect(sse.events[0]).toMatchObject({ type: "run.status", payload: { status: "running", phase: "debate", thinking: "pm" } });
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
    await runOne("r1", sse, { db, gateway, sink, now: () => 0 }, CFG);

    expect(state.messages).toHaveLength(0);
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(String(state.runs[0].error)).toMatch(/stalled/);
    expect(sse.events.at(-1)).toMatchObject({ type: "run.error", payload: { phase: "debate", reason: "model_error" } });
    expect(sink.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "run_failed", run_id: "r1" }));
    expect(sink.insert).toHaveBeenCalledTimes(1); // exactly one run_failed, no debate_completed
    expect(sse.close).toHaveBeenCalledOnce();
  });
});
