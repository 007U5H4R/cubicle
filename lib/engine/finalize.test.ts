import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "@/lib/events";
import type { Gateway, Source, Usage } from "@/lib/gateway";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import { costCents } from "./cost";
import type { DeliverCfg, DeliverOutcome } from "./deliver";
import { authorizeRetry, completeRunIfAllDone, finalizeDeliver, runRetry } from "./finalize";

// TSK-07.4 finalize/retry tests, offline against in-memory doubles (mirroring run.test.ts /
// deliver.test.ts): a column-allowlist db double over `runs` / `artifacts` / `messages` supporting
// the query shapes finalize.ts uses (runs update().eq() + select().eq().single(); artifacts
// upsert() + update().match() + select().eq() list; messages select().eq().order()), a scripted
// streaming gateway keyed per artifact type, an sse recorder, a stub sink, and an injectable clock.

type Row = Record<string, unknown>;
type Table = "runs" | "artifacts" | "messages";

const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  artifacts: new Set(["run_id", "type", "status", "content_md", "grounded", "sources", "tokens_in", "tokens_out", "created_at", "finished_at"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
};

function makeDb(seed: Partial<Record<Table, Row[]>> = {}) {
  const state = { runs: [...(seed.runs ?? [])], artifacts: [...(seed.artifacts ?? [])], messages: [...(seed.messages ?? [])] };
  const badKey = (name: Table, patch: Row) => Object.keys(patch).find((k) => !COLUMNS[name].has(k));
  const pgrst204 = (name: Table, col: string) => ({ error: { message: `Could not find the '${col}' column of '${name}' in the schema cache`, code: "PGRST204" } });
  function from(name: Table) {
    const rows = state[name];
    const filtered = (conds: [string, unknown][]) => rows.filter((r) => conds.every(([c, v]) => r[c] === v));
    function selectChain(conds: [string, unknown][]) {
      return {
        eq(col: string, val: unknown) { return selectChain([...conds, [col, val]]); },
        single() { const found = filtered(conds); return Promise.resolve(found[0] ? { data: found[0], error: null } : { data: null, error: { message: "not found" } }); },
        order() { return Promise.resolve({ data: filtered(conds), error: null }); },
        then(resolve: (r: { data: Row[]; error: null }) => unknown) { return Promise.resolve({ data: filtered(conds), error: null }).then(resolve); },
      };
    }
    return {
      update(patch: Row) {
        const bad = badKey(name, patch);
        const apply = (conds: [string, unknown][]) => { if (bad) return Promise.resolve(pgrst204(name, bad)); for (const r of filtered(conds)) Object.assign(r, patch); return Promise.resolve({ error: null }); };
        return { eq(col: string, val: unknown) { return apply([[col, val]]); }, match(criteria: Row) { return apply(Object.entries(criteria)); } };
      },
      upsert(row: Row) {
        const bad = badKey(name, row);
        if (bad) return Promise.resolve(pgrst204(name, bad));
        const existing = rows.find((r) => r.run_id === row.run_id && r.type === row.type);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      select() { return selectChain([]); },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

const u = (input: number, output: number): Usage => ({ input, output });

type StreamAttempt = { deltas: string[]; done: { usage: Usage; sources: Source[] } } | { throw: Error };

function systemToType(system: string): ArtifactType {
  const t = ARTIFACT_TYPES.find((type) => ROLE_PREFIX[ARTIFACT_ROLE[type]] === system);
  if (!t) throw new Error("stream() called with an unknown system prefix");
  return t;
}

function streamGateway(scripts: Partial<Record<ArtifactType, StreamAttempt[]>>): Gateway {
  const queues: Record<ArtifactType, StreamAttempt[]> = { prd: [...(scripts.prd ?? [])], scan: [...(scripts.scan ?? [])], copy: [...(scripts.copy ?? [])], plan: [...(scripts.plan ?? [])] };
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
  const chat = (async () => { throw new Error("chat is not used by the retry path"); }) as Gateway["chat"];
  return { chat, stream };
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

const runFailedCalls = (sink: EventSink) => (sink.insert as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as { name: string }).name === "run_failed");
const packCompletedCalls = (sink: EventSink) => (sink.insert as ReturnType<typeof vi.fn>).mock.calls.filter((c) => (c[0] as { name: string }).name === "pack_completed");

const CFG: DeliverCfg = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 60_000 };
const artifact = (type: ArtifactType, status: string, over: Row = {}): Row => ({ run_id: "r1", type, status, grounded: false, sources: [], tokens_in: 0, tokens_out: 0, content_md: "", finished_at: null, ...over });

describe("finalizeDeliver", () => {
  it("complete path: sums tokens, marks the run complete, tracks pack_completed, streams run.done", async () => {
    const { db, state } = makeDb({ runs: [{ id: "r1", status: "running", started_at: new Date(1000).toISOString(), tokens_in: 0, tokens_out: 0 }] });
    const sse = sseDouble();
    const sink = stubSink();
    const deliver: DeliverOutcome = { status: "complete", grounded: true, usage: u(300, 120), artifacts: { prd: "done", scan: "done", copy: "done", plan: "done" } };
    await finalizeDeliver({ deps: { db, gateway: streamGateway({}), sink, now: () => 5000 }, sse, runId: "r1", anonSessionId: "s1", startedAt: 1000, stopReason: "done", debateTokens: u(500, 200), deliver });

    const total = u(800, 320);
    expect(state.runs[0]).toMatchObject({ status: "complete", stop_reason: "done", tokens_in: 800, tokens_out: 320, cost_cents: costCents(total) });
    expect(state.runs[0].finished_at).toBeTruthy();
    expect(packCompletedCalls(sink)[0][0]).toMatchObject({ name: "pack_completed", run_id: "r1", props: { wall_s: 4, tokens: 1120, grounded: true } });
    expect(sse.events.at(-1)).toEqual({ type: "run.done", payload: { status: "complete", wall_s: 4, tokens: 1120, cost_cents: costCents(total) } });
  });

  it.each(["timeout", "budget", "model_error"] as const)("failed path (%s): persists tokens/cost, tracks run_failed{deliver}, streams run.error", async (reason) => {
    const { db, state } = makeDb({ runs: [{ id: "r1", status: "running", started_at: new Date(0).toISOString(), tokens_in: 0, tokens_out: 0 }] });
    const sse = sseDouble();
    const sink = stubSink();
    const deliver: DeliverOutcome = { status: "failed", reason, grounded: false, usage: u(100, 40), artifacts: { prd: "done", scan: "done", copy: "done", plan: "failed" } };
    await finalizeDeliver({ deps: { db, gateway: streamGateway({}), sink, now: () => 2000 }, sse, runId: "r1", anonSessionId: "s1", startedAt: 0, stopReason: "done", debateTokens: u(400, 300), deliver });

    const total = u(500, 340);
    expect(state.runs[0]).toMatchObject({ status: "failed", tokens_in: 500, tokens_out: 340, cost_cents: costCents(total), error: `deliver failed: ${reason}` });
    expect(runFailedCalls(sink)[0][0]).toMatchObject({ name: "run_failed", props: { phase: "deliver", reason } });
    expect(sse.events.at(-1)).toEqual({ type: "run.error", payload: { phase: "deliver", reason } });
    expect(packCompletedCalls(sink)).toHaveLength(0);
  });
});

describe("completeRunIfAllDone", () => {
  it("all four done: completes the run, tracks pack_completed with grounded from the scan row", async () => {
    const { db, state } = makeDb({
      runs: [{ id: "r1", status: "failed", started_at: new Date(1000).toISOString(), tokens_in: 700, tokens_out: 300, cost_cents: 42 }],
      artifacts: [artifact("prd", "done"), artifact("scan", "done", { grounded: true }), artifact("copy", "done"), artifact("plan", "done")],
    });
    const sse = sseDouble();
    const sink = stubSink();
    const done = await completeRunIfAllDone({ deps: { db, gateway: streamGateway({}), sink, now: () => 4000 }, sse, runId: "r1", anonSessionId: "s1" });

    expect(done).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "complete" });
    expect(state.runs[0].finished_at).toBeTruthy();
    expect(packCompletedCalls(sink)[0][0]).toMatchObject({ name: "pack_completed", props: { wall_s: 3, tokens: 1000, grounded: true } });
    expect(sse.events.at(-1)).toEqual({ type: "run.done", payload: { status: "complete", wall_s: 3, tokens: 1000, cost_cents: 42 } });
  });

  it("not all done: returns false and writes nothing", async () => {
    const { db, state } = makeDb({
      runs: [{ id: "r1", status: "failed", started_at: new Date(0).toISOString(), tokens_in: 100, tokens_out: 50, cost_cents: 5 }],
      artifacts: [artifact("prd", "done"), artifact("scan", "done"), artifact("copy", "done"), artifact("plan", "failed")],
    });
    const sse = sseDouble();
    const sink = stubSink();
    const done = await completeRunIfAllDone({ deps: { db, gateway: streamGateway({}), sink, now: () => 4000 }, sse, runId: "r1", anonSessionId: "s1" });

    expect(done).toBe(false);
    expect(state.runs[0].status).toBe("failed");
    expect(state.runs[0].finished_at).toBeFalsy();
    expect(packCompletedCalls(sink)).toHaveLength(0);
    expect(sse.events).toHaveLength(0);
  });
});

describe("authorizeRetry (TC-032)", () => {
  const seed = () => makeDb({
    runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", started_at: new Date(0).toISOString() }],
    artifacts: [artifact("plan", "failed"), artifact("prd", "done")],
  });

  it("foreign cookie → 404", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "r1", "plan", "other")).toEqual({ ok: false, status: 404 });
  });
  it("unknown run → 404", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "nope", "plan", "s1")).toEqual({ ok: false, status: 404 });
  });
  it("bad artifact type → 404", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "r1", "bogus", "s1")).toEqual({ ok: false, status: 404 });
  });
  it("missing cookie → 404", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "r1", "plan", undefined)).toEqual({ ok: false, status: 404 });
  });
  it("owned + done artifact → 409 not_failed", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "r1", "prd", "s1")).toEqual({ ok: false, status: 409, error: "not_failed" });
  });
  it("owned + missing artifact → 409 not_failed", async () => {
    const { db } = seed();
    expect(await authorizeRetry(db, "r1", "scan", "s1")).toEqual({ ok: false, status: 409, error: "not_failed" });
  });
  it("owned + failed artifact → ok with the run", async () => {
    const { db } = seed();
    const res = await authorizeRetry(db, "r1", "plan", "s1");
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.run).toMatchObject({ id: "r1", idea: "idea", anon_session_id: "s1" });
  });
});

describe("runRetry (TC-031 completion half)", () => {
  const seedThreeDoneOneFailed = () => makeDb({
    runs: [{ id: "r1", idea: "idea", anon_session_id: "s1", status: "failed", started_at: new Date(1000).toISOString(), tokens_in: 700, tokens_out: 300, cost_cents: 40, error: "deliver failed: model_error" }],
    artifacts: [artifact("prd", "done"), artifact("scan", "done", { grounded: true }), artifact("copy", "done"), artifact("plan", "failed", { content_md: "old partial", finished_at: new Date(0).toISOString() })],
    messages: [{ id: "m1", run_id: "r1", seq: 1, from_role: "pm", to_role: "team", act: "propose", subject: "s", body: "b", reply_to: null, hops: 0, brief: null, created_at: new Date(0).toISOString() }],
  });

  it("retried desk finishes → artifact flips done, run tokens grow, run completes with pack_completed", async () => {
    const { db, state } = seedThreeDoneOneFailed();
    const sse = sseDouble();
    const sink = stubSink();
    const gateway = streamGateway({ plan: [{ deltas: ["fresh plan"], done: { usage: u(50, 20), sources: [] } }] });
    await runRetry({ deps: { db, gateway, sink, now: () => 5000 }, sse, runId: "r1", type: "plan", idea: "idea", anonSessionId: "s1", startedAt: 1000, cfg: CFG });

    const plan = state.artifacts.find((a) => a.type === "plan")!;
    expect(plan.status).toBe("done");
    expect(plan.content_md).toBe("fresh plan"); // old partial overwritten by the upsert reset.
    expect(state.runs[0]).toMatchObject({ status: "complete", tokens_in: 750, tokens_out: 320, cost_cents: costCents(u(750, 320)) });
    expect(packCompletedCalls(sink)[0][0]).toMatchObject({ name: "pack_completed", props: { wall_s: 4, tokens: 1070, grounded: true } });
    expect(sse.events.at(-1)).toEqual({ type: "run.done", payload: { status: "complete", wall_s: 4, tokens: 1070, cost_cents: costCents(u(750, 320)) } });
    expect(sse.close).toHaveBeenCalledOnce();
  });

  it("retried desk fails again → run stays failed, no pack_completed, no second run_failed", async () => {
    const { db, state } = seedThreeDoneOneFailed();
    const sse = sseDouble();
    const sink = stubSink();
    // plan throws on both the attempt and its one retry → deliverOne returns failed.
    const gateway = streamGateway({ plan: [{ throw: new Error("still down") }, { throw: new Error("still down again") }] });
    await runRetry({ deps: { db, gateway, sink, now: () => 5000 }, sse, runId: "r1", type: "plan", idea: "idea", anonSessionId: "s1", startedAt: 1000, cfg: CFG });

    expect(state.artifacts.find((a) => a.type === "plan")!.status).toBe("failed");
    expect(state.runs[0].status).toBe("failed"); // unchanged.
    expect(packCompletedCalls(sink)).toHaveLength(0);
    expect(runFailedCalls(sink)).toHaveLength(0); // the first pass owned the single run_failed; retry emits none.
    expect(sse.events.some((e) => e.type === "run.done")).toBe(false);
    expect(sse.close).toHaveBeenCalledOnce();
  });
});
