import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "@/lib/events";
import type { Gateway } from "@/lib/gateway";
import type { AgentOutput } from "./envelope";
import type { OrchestratorDecision } from "./orchestrate";
import { runDebate, type DebateCfg, type DebateCtx } from "./debate";

// TSK-06.4 debate-loop tests, offline against in-memory doubles (copied from run.test.ts: the
// column-allowlist db double, sse recorder, stub sink) plus a scripted gateway that returns a
// queued sequence of orchestrator decisions and agent envelopes by call kind. Test names map to
// Solution-PRD §5.1/§5.2 rows and the ticket TC ids.

type Row = Record<string, unknown>;
type Table = "runs" | "messages";

// Real column sets from supabase/migrations/0001_init.sql — insert() rejects any key outside this
// list, mirroring PostgREST's PGRST204 (the `messages` table has `to_role`, never `to`).
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

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

/** Scripted gateway: pops from a per-kind queue on each chat() call. An Error entry is thrown (to
 * exercise decideNext's failure signal and the agent retry/skip path). `onCall` lets a test advance
 * the injected clock at a precise call. */
type ScriptEntry<T> = T | Error;
function scriptGateway(
  script: { orchestrator?: ScriptEntry<OrchestratorDecision>[]; agent?: ScriptEntry<AgentOutput>[] },
  opts: { usage?: { input: number; output: number }; onCall?: (kind: "orchestrator" | "agent", calls: { orchestrator: number; agent: number }) => void } = {},
) {
  const orch = [...(script.orchestrator ?? [])];
  const agent = [...(script.agent ?? [])];
  const usage = opts.usage ?? { input: 100, output: 100 };
  const calls = { orchestrator: 0, agent: 0 };
  const chat = (async (kind: "orchestrator" | "agent") => {
    calls[kind]++;
    opts.onCall?.(kind, calls);
    const q = kind === "orchestrator" ? orch : agent;
    const next = q.shift();
    if (next === undefined) throw new Error(`no scripted ${kind} response`);
    if (next instanceof Error) throw next;
    return { data: next, usage };
  }) as Gateway["chat"];
  const stream = (async function* () {}) as Gateway["stream"];
  return { gateway: { chat, stream } as Gateway, calls };
}

const dec = (next: OrchestratorDecision["next"], brief = "go"): OrchestratorDecision => ({ next, brief });
const agent = (to: AgentOutput["to"], act: AgentOutput["act"], subject: string, body: string): AgentOutput => ({ to, act, subject, body });

const HIGH_CFG: DebateCfg = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 };

function ctx(over: Partial<DebateCtx> & Pick<DebateCtx, "deps" | "sse">): DebateCtx {
  return { runId: "r1", idea: "A reminder app for solo founders", anonSessionId: "s1", cfg: HIGH_CFG, startedAt: 0, ...over };
}

describe("runDebate", () => {
  it("§5.1/§5.2 happy path: pm first, researcher early, objection answered next turn, stop=done", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    const { gateway } = scriptGateway({
      orchestrator: [dec("pm"), dec("researcher"), dec("designer"), dec("developer"), dec("pm"), dec("researcher"), dec("done")],
      agent: [
        agent("team", "propose", "Frame", "pm frames problem, user, value for solo founders"),
        agent("team", "propose", "Market", "researcher notes existing reminder tools already exist"),
        agent("team", "propose", "Promise", "designer drafts a headline a stranger would click"),
        agent("team", "propose", "Slice", "developer cuts scope to the smallest buildable slice"),
        agent("researcher", "objection", "Pushback", "pm objects that the market read misses the wedge"),
        agent("pm", "agree", "Concede", "researcher answers and concedes the narrower wedge"),
      ],
    });
    let clock = 0;
    const outcome = await runDebate(ctx({ deps: { db, gateway, sink, now: () => clock++ }, sse }));

    expect(state.messages).toHaveLength(6);
    expect(state.messages[0]).toMatchObject({ seq: 1, from_role: "pm" });
    expect(state.messages[0]).not.toHaveProperty("to");
    expect(state.messages.some((m) => m.from_role === "researcher")).toBe(true);
    // The objection (msg 5) is answered by its addressee (msg 6) — reply chain wired.
    expect(state.messages[4]).toMatchObject({ act: "objection", to_role: "researcher", reply_to: null, hops: 0 });
    expect(state.messages[5]).toMatchObject({ from_role: "researcher", reply_to: state.messages[4].id, hops: 1 });
    expect(outcome.stop_reason).toBe("done");
    expect(outcome.objections).toBe(1);
    expect(sink.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "debate_completed", run_id: "r1", props: { messages: 6, objections: 1, stop_reason: "done" } }));
    // SSE order is run.status,message repeated — no run.done here (run.ts owns that), no steer.
    expect(sse.events.map((e) => e.type)).toEqual(Array.from({ length: 6 }, () => ["run.status", "message"]).flat());
  });

  it("TC-027: office steers at 35s — one steer message, streamed, no model call for it", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    let clock = 0;
    const { gateway, calls } = scriptGateway(
      { orchestrator: [dec("pm"), dec("researcher"), dec("done")], agent: [agent("team", "propose", "Frame", "pm frames it"), agent("team", "propose", "Market", "researcher weighs in")] },
      { onCall: (kind, c) => { if (kind === "agent" && c.agent === 1) clock = 36_000; } },
    );
    const outcome = await runDebate(ctx({ deps: { db, gateway, sink, now: () => clock }, sse }));

    const office = state.messages.filter((m) => m.from_role === "office");
    expect(office).toHaveLength(1);
    expect(office[0]).toMatchObject({ to_role: "team", act: "agree", body: "Wrap it up, we deliver in ten seconds." });
    expect(office[0]).not.toHaveProperty("to");
    const steerEvents = sse.events.filter((e) => e.type === "steer");
    expect(steerEvents).toHaveLength(1);
    expect(steerEvents[0].payload).toMatchObject({ body: "Wrap it up, we deliver in ten seconds." });
    expect(calls.agent).toBe(2); // no agent call was spent on the steer
    expect(state.messages).toHaveLength(3); // pm, office, researcher
    expect(outcome.stop_reason).toBe("done");
  });

  it("TC-028: orchestrator fails twice → fixed order, still emits debate_completed with the real stop_reason", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    const { gateway, calls } = scriptGateway({
      orchestrator: [new Error("orchestrator down"), new Error("orchestrator down")],
      agent: [
        agent("team", "propose", "One", "point one from the team"),
        agent("team", "propose", "Two", "point two from the team"),
        agent("team", "propose", "Three", "point three from the team"),
        agent("team", "propose", "Four", "point four from the team"),
        agent("team", "propose", "Five", "point five from the team"),
      ],
    });
    let clock = 0;
    const outcome = await runDebate(ctx({ cfg: { DEBATE_MSG_CAP: 5, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 }, deps: { db, gateway, sink, now: () => clock++ }, sse }));

    expect(calls.orchestrator).toBe(2); // failed twice, never consulted again
    expect(calls.agent).toBe(5);
    expect(state.messages).toHaveLength(5);
    expect(state.messages[0]).toMatchObject({ from_role: "pm" }); // fixed order still starts at pm
    expect(outcome.stop_reason).toBe("cap_messages");
    expect(sink.insert).toHaveBeenCalledWith(expect.objectContaining({ name: "debate_completed", props: { messages: 5, objections: 0, stop_reason: "cap_messages" } }));
  });

  it("agent call retries once then succeeds — message is persisted", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const { gateway, calls } = scriptGateway({ orchestrator: [dec("pm"), dec("done")], agent: [new Error("transient blip"), agent("team", "propose", "Frame", "pm frames it after a retry")] });
    let clock = 0;
    const outcome = await runDebate(ctx({ deps: { db, gateway, sink: stubSink(), now: () => clock++ }, sse }));

    expect(calls.agent).toBe(2); // one failure + one success on the same turn
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toMatchObject({ from_role: "pm", seq: 1 });
    expect(outcome.stop_reason).toBe("done");
  });

  it("agent call throws twice → the turn is skipped (no message) and the loop continues", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const { gateway, calls } = scriptGateway({ orchestrator: [dec("pm"), dec("pm"), dec("done")], agent: [new Error("down"), new Error("down"), agent("team", "propose", "Frame", "pm frames it on the next turn")] });
    let clock = 0;
    const outcome = await runDebate(ctx({ deps: { db, gateway, sink: stubSink(), now: () => clock++ }, sse }));

    expect(calls.agent).toBe(3); // 2 (skipped turn) + 1 (next turn succeeds)
    expect(state.messages).toHaveLength(1); // the skipped turn persisted nothing
    expect(outcome.stop_reason).toBe("done");
  });

  it("§5.2 override: a rule-breaking pick is corrected and the brief is prefixed [override: rule N]", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    // Orchestrator picks researcher first, violating rule 1 (pm speaks first).
    const { gateway } = scriptGateway({ orchestrator: [dec("researcher"), dec("done")], agent: [agent("team", "propose", "Frame", "pm frames it")] });
    let clock = 0;
    await runDebate(ctx({ deps: { db, gateway, sink: stubSink(), now: () => clock++ }, sse }));

    expect(state.messages[0]).toMatchObject({ from_role: "pm" });
    expect(String(state.messages[0].brief)).toMatch(/^\[override: rule 1] /);
  });

  it("§5.1 stop guard: cap_messages ends the debate, and the steer counts toward the cap", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "running" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    let clock = 0;
    const { gateway } = scriptGateway(
      { orchestrator: [dec("pm"), dec("researcher")], agent: [agent("team", "propose", "Frame", "pm frames it"), agent("team", "propose", "Market", "researcher weighs in")] },
      { onCall: (kind, c) => { if (kind === "agent" && c.agent === 1) clock = 36_000; } },
    );
    const outcome = await runDebate(ctx({ cfg: { DEBATE_MSG_CAP: 3, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 }, deps: { db, gateway, sink, now: () => clock }, sse }));

    expect(state.messages).toHaveLength(3);
    expect(state.messages.filter((m) => m.from_role === "office")).toHaveLength(1); // steer occupied one slot
    expect(outcome.stop_reason).toBe("cap_messages");
  });
});
