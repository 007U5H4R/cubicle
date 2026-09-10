import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { Gateway, Source, Usage } from "@/lib/gateway";
import { EVENTS, type EventSink } from "@/lib/events";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import type { AgentOutput } from "./envelope";
import type { OrchestratorDecision } from "./orchestrate";
import type { DebateCfg } from "./debate";
import type { DeliverCfg } from "./deliver";
import { runOne } from "./run";

// TSK-08.3 — table-driven proof that every §13 failure path emits EXACTLY ONE `run_failed` event
// with a valid {phase, reason} pair, end-to-end through `runOne` (the real integration, offline
// against in-memory doubles). The two emitters — the run.ts catch and finalize.ts's failed-deliver
// branch — must never both fire for the same run. Doubles below mirror run.test.ts/deliver.test.ts
// faithfully (column-allowlist db, scripted gateway, sse/sink recorders); the only addition is a
// `hang` stream attempt (from deliver.test.ts) and an optional `runs`-update failure hook, needed to
// drive the wall/budget caps and the nested-error row through the real integration path.

type Row = Record<string, unknown>;
type Table = "runs" | "messages" | "artifacts";

const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
  artifacts: new Set(["run_id", "type", "status", "content_md", "grounded", "sources", "tokens_in", "tokens_out", "created_at", "finished_at"]),
};

/** Same in-memory db double as run.test.ts, plus an optional hook that forces a `runs.update` call
 * to fail (PGRST-shaped error) when its patch matches `failRunsUpdateIf` — used only by the
 * nested-error row to make finalize.ts's own runs-update fail so its throw escalates into run.ts's
 * catch, proving the catch still emits exactly one run_failed rather than a second one on top of a
 * (never-reached) finalize emit. */
function makeDb(seed: { runs: Row[]; messages: Row[]; artifacts?: Row[] }, opts: { failRunsUpdateIf?: (patch: Row) => boolean } = {}) {
  const state = { runs: [...seed.runs], messages: [...seed.messages], artifacts: [...(seed.artifacts ?? [])] };
  const badKey = (name: Table, patch: Row) => Object.keys(patch).find((k) => !COLUMNS[name].has(k));
  const pgrst204 = (name: Table, col: string) => ({ error: { message: `Could not find the '${col}' column of '${name}' in the schema cache`, code: "PGRST204" } });
  function from(name: Table) {
    const rows = state[name];
    return {
      update(patch: Row) {
        const bad = badKey(name, patch);
        return {
          eq(col: string, val: unknown) {
            if (bad) return Promise.resolve(pgrst204(name, bad));
            if (name === "runs" && opts.failRunsUpdateIf?.(patch)) return Promise.resolve({ error: { message: "simulated runs update failure" } });
            const row = rows.find((r) => r[col] === val);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
          match(criteria: Row) {
            if (bad) return Promise.resolve(pgrst204(name, bad));
            const row = rows.find((r) => Object.entries(criteria).every(([k, v]) => r[k] === v));
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
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

/** One scripted streaming attempt: deltas+done, a thrown error, or (from deliver.test.ts) a hang
 * that only resolves — by throwing — when the shared AbortSignal fires. `hang` is what the
 * wall-timeout and budget rows use to keep one desk in flight while the cap trips. */
type StreamAttempt = { deltas: string[]; done: { usage: Usage; sources: Source[] } } | { throw: Error } | { hang: true };

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
  const stream = ((_kind: "artifact" | "grounded", system: string, _user: string, opts?: { signal?: AbortSignal }) => {
    const type = systemToType(system);
    const attempt = queues[type].shift();
    if (!attempt) throw new Error(`no scripted stream attempt for ${type}`);
    return (async function* () {
      if ("throw" in attempt) throw attempt.throw;
      if ("hang" in attempt) {
        await new Promise<never>((_, reject) => {
          const sig = opts?.signal;
          if (sig?.aborted) return reject(sig.reason);
          sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
        });
        throw new Error("unreachable");
      }
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

/** Every sink.insert row whose name is run_failed, in call order. */
function runFailedRows(sink: EventSink): { name: string; props: { phase: string; reason: string }; run_id: string | null }[] {
  return (sink.insert as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[0] as { name: string; props: { phase: string; reason: string }; run_id: string | null })
    .filter((r) => r.name === "run_failed");
}

const CFG: DebateCfg = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 120, RUN_TOKEN_CAP: 1_000_000 };
// A trivial debate cfg (DEBATE_MSG_CAP: 0) makes evaluateStop fire "cap_messages" on the very first
// loop check, before any gateway.chat call — used by the deliver-focused rows (wall/budget/nested)
// that don't care about debate content and would otherwise need to script a full orchestrator+agent
// exchange just to reach the deliver phase.
const TRIVIAL_DEBATE_CFG: DebateCfg = { ...CFG, DEBATE_MSG_CAP: 0 };
const DELIVER_CFG: DeliverCfg = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 1_000_000 };
const pmOutput: AgentOutput = { to: "team", act: "propose", subject: "Reminders for solo founders", body: "I think the value is fewer missed follow-ups. Unsure if solo founders will pay monthly." };

describe("run_failed: exactly one per §13 failure path (TC-039 / TKT-08 AC5)", () => {
  it("debate model outage → {phase: debate, reason: model_error}", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    const failingChat = (async () => { throw new Error("model unavailable"); }) as Gateway["chat"];
    const gateway = scriptGateway({}, { chat: failingChat });

    await runOne("r1", sse, { db, gateway, sink, now: () => 0 }, CFG, DELIVER_CFG);

    const runFailed = runFailedRows(sink);
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ run_id: "r1", props: { phase: "debate", reason: "model_error" } });
    expect(EVENTS.run_failed.safeParse(runFailed[0].props).success).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(sse.events.filter((e) => e.type === "run.error")).toHaveLength(1);
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("deliver desk fails (throws twice) → {phase: deliver, reason: model_error}", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    const streams: Record<ArtifactType, StreamAttempt[]> = { ...OK_STREAMS, plan: [{ throw: new Error("plan model error") }, { throw: new Error("plan model error again") }] };
    const gateway = scriptGateway({ orchestrator: [{ next: "pm", brief: "open it" }, { next: "done", brief: "wrap" }], agent: [pmOutput] }, {}, streams);
    let clock = 0;

    await runOne("r1", sse, { db, gateway, sink, now: () => clock++ }, CFG, DELIVER_CFG);

    const runFailed = runFailedRows(sink);
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ run_id: "r1", props: { phase: "deliver", reason: "model_error" } });
    expect(EVENTS.run_failed.safeParse(runFailed[0].props).success).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(sse.events.filter((e) => e.type === "run.error")).toHaveLength(1);
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("deliver wall timeout (one desk hangs past RUN_WALL_CAP_S) → {phase: deliver, reason: timeout}", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    const streams: Record<ArtifactType, StreamAttempt[]> = { ...OK_STREAMS, plan: [{ hang: true }] };
    const gateway = scriptGateway({}, {}, streams);
    // First now() call is runOne's startedAt (0); every call after is far past startedAt + the 90s
    // wall cap, so runDeliver's remaining-time computation clamps to 0 and the wall timer fires on
    // the next tick — after the three fast desks have already settled done (deliver.test.ts's TC-033
    // wall-half pattern, driven here through the full runOne integration).
    let calls = 0;
    const now = () => (calls++ === 0 ? 0 : 200_000);

    await runOne("r1", sse, { db, gateway, sink, now }, TRIVIAL_DEBATE_CFG, DELIVER_CFG);

    const runFailed = runFailedRows(sink);
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ run_id: "r1", props: { phase: "deliver", reason: "timeout" } });
    expect(EVENTS.run_failed.safeParse(runFailed[0].props).success).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(sse.events.filter((e) => e.type === "run.error")).toHaveLength(1);
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("deliver token budget exceeded (done usages cross RUN_TOKEN_CAP) → {phase: deliver, reason: budget}", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] });
    const sse = sseDouble();
    const sink = stubSink();
    // Debate contributes 0 tokens (TRIVIAL_DEBATE_CFG). prd(200) + scan(200) + copy(80) already sum
    // past a 300-token cap regardless of settle order, tripping the budget breaker on the hanging plan
    // desk — mirrors deliver.test.ts's TC-033 budget-half math with the debate's share zeroed out.
    const streams: Record<ArtifactType, StreamAttempt[]> = {
      ...OK_STREAMS,
      prd: [{ deltas: ["prd"], done: { usage: u(200, 0), sources: [] } }],
      scan: [{ deltas: ["scan"], done: { usage: u(200, 0), sources: [{ title: "Acme", url: "https://acme.test" }] } }],
      plan: [{ hang: true }],
    };
    const gateway = scriptGateway({}, {}, streams);
    const tightDeliverCfg: DeliverCfg = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 300 };
    let clock = 0;

    await runOne("r1", sse, { db, gateway, sink, now: () => clock++ }, TRIVIAL_DEBATE_CFG, tightDeliverCfg);

    const runFailed = runFailedRows(sink);
    expect(runFailed).toHaveLength(1);
    expect(runFailed[0]).toMatchObject({ run_id: "r1", props: { phase: "deliver", reason: "budget" } });
    expect(EVENTS.run_failed.safeParse(runFailed[0].props).success).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "failed" });
    expect(sse.events.filter((e) => e.type === "run.error")).toHaveLength(1);
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("no duplicate on a nested error: finalize's own runs-update fails and escalates into run.ts's catch — still exactly one run_failed", async () => {
    // Genuine nested-error double (not the weaker "no run emits >1" fallback): the deliver phase
    // fails normally (a desk throws twice → runDeliver returns {status:"failed", reason:"model_error"}),
    // so finalize.ts's failed branch runs — but its own `runs` UPDATE (the one that would immediately
    // precede finalize's track(run_failed) call) is rigged to error. finalize.ts throws BEFORE calling
    // track (finalize.ts:58-63: the update-error throw sits above the track call), so finalize emits
    // NOTHING, and the throw propagates up into run.ts's own try/catch, which sets its own `runs` row
    // failed and calls track(run_failed) exactly once. This proves the invariant survives a second,
    // independent failure arriving after the first one was already in flight — the two emitters truly
    // never both fire, even when the "normal" emitter (finalize) is knocked out mid-write.
    const { db, state } = makeDb(
      { runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "queued" }], messages: [] },
      { failRunsUpdateIf: (patch) => typeof patch.error === "string" && patch.error.startsWith("deliver failed:") },
    );
    const sse = sseDouble();
    const sink = stubSink();
    const streams: Record<ArtifactType, StreamAttempt[]> = { ...OK_STREAMS, plan: [{ throw: new Error("plan model error") }, { throw: new Error("plan model error again") }] };
    const gateway = scriptGateway({}, {}, streams);

    await runOne("r1", sse, { db, gateway, sink, now: () => 0 }, TRIVIAL_DEBATE_CFG, DELIVER_CFG);

    const runFailed = runFailedRows(sink);
    expect(runFailed).toHaveLength(1); // exactly one — not zero (finalize's emit was blocked), not two.
    // The run.ts catch always labels its own emit "model_error" (it does not know finalize's original
    // deliver reason) — this is the expected, already-documented behavior, not a bug this test found.
    expect(runFailed[0]).toMatchObject({ run_id: "r1", props: { phase: "deliver", reason: "model_error" } });
    expect(EVENTS.run_failed.safeParse(runFailed[0].props).success).toBe(true);
    // The outer catch's own `runs` update (a different patch — its error message, not the
    // "deliver failed:" prefix) is not rigged to fail, so it lands: the run still ends failed.
    expect(state.runs[0]).toMatchObject({ status: "failed", error: "simulated runs update failure" });
    expect(sse.events.filter((e) => e.type === "run.error")).toHaveLength(1);
    expect(sse.close).toHaveBeenCalledOnce();
  });
});
