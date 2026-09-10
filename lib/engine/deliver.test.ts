import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "@/lib/events";
import type { Gateway, Source, Usage } from "@/lib/gateway";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import { deliverOne, runDeliver, type DeliverCfg, type DeliverCtx } from "./deliver";

// TSK-07.2/07.3 deliver-engine tests, offline against in-memory doubles (mirroring run.test.ts /
// debate.test.ts): a column-allowlist `artifacts` db double enforcing the composite (run_id,type)
// PK, a scripted streaming gateway keyed per artifact type (recording the `kind` it was called
// with), an sse recorder, a stub sink, and an injectable clock. Test names map to the deferred live
// TCs (TC-029..TC-033) — we assert plumbing, persistence, caps, fallback, and SSE, not model content.

type Row = Record<string, unknown>;

// Real column set from supabase/migrations/0001_init.sql — upsert()/update() reject any key outside
// this list, mirroring PostgREST's PGRST204, so a schema-mismatch bug is caught offline.
const ARTIFACT_COLUMNS: ReadonlySet<string> = new Set([
  "run_id",
  "type",
  "status",
  "content_md",
  "grounded",
  "sources",
  "tokens_in",
  "tokens_out",
  "created_at",
  "finished_at",
]);

function makeDb(seed: Row[] = []) {
  const state = { artifacts: [...seed] };
  const badKey = (patch: Row) => Object.keys(patch).find((k) => !ARTIFACT_COLUMNS.has(k));
  const pgrst204 = (col: string) => ({ error: { message: `Could not find the '${col}' column of 'artifacts' in the schema cache`, code: "PGRST204" } });
  const findRow = (criteria: Row) => state.artifacts.find((r) => r.run_id === criteria.run_id && r.type === criteria.type);
  function from(name: string) {
    if (name !== "artifacts") throw new Error(`unexpected table: ${name}`);
    return {
      upsert(row: Row) {
        const bad = badKey(row);
        if (bad) return Promise.resolve(pgrst204(bad));
        const existing = findRow(row);
        if (existing) Object.assign(existing, row);
        else state.artifacts.push({ ...row });
        return Promise.resolve({ error: null });
      },
      update(patch: Row) {
        return {
          match(criteria: Row) {
            const bad = badKey(patch);
            if (bad) return Promise.resolve(pgrst204(bad));
            const row = findRow(criteria);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

/** One scripted streaming attempt: a delta sequence + done, a thrown error, or a stream that hangs
 * until the shared signal aborts (then throws) — for the wall/budget-cap tests. */
type Attempt = { deltas: string[]; done: { usage: Usage; sources: Source[] } } | { throw: Error } | { hang: true };

function systemToType(system: string): ArtifactType {
  const t = ARTIFACT_TYPES.find((type) => ROLE_PREFIX[ARTIFACT_ROLE[type]] === system);
  if (!t) throw new Error("stream() called with an unknown system prefix");
  return t;
}

/** Scripted streaming gateway: pops the next Attempt from the queue for the artifact type (resolved
 * from the system prefix) on each stream() call, and records the (type, kind) of every call so a
 * test can assert the scan used "grounded" and its fallback used "artifact". */
function streamGateway(scripts: Partial<Record<ArtifactType, Attempt[]>>) {
  const calls: { type: ArtifactType; kind: "artifact" | "grounded" }[] = [];
  const queues: Record<ArtifactType, Attempt[]> = { prd: [...(scripts.prd ?? [])], scan: [...(scripts.scan ?? [])], copy: [...(scripts.copy ?? [])], plan: [...(scripts.plan ?? [])] };
  const stream = ((kind: "artifact" | "grounded", system: string, _user: string, opts?: { signal?: AbortSignal }) => {
    const type = systemToType(system);
    calls.push({ type, kind });
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
  const chat = (async () => { throw new Error("chat is not used by the deliver engine"); }) as Gateway["chat"];
  return { gateway: { chat, stream } as Gateway, calls };
}

/** Single-type streaming gateway that yields the given deltas then done, advancing a shared mutable
 * clock by `tickMs` AFTER each delta so a test can drive the 400ms time-threshold flush branch. With
 * `tickMs: 0` the clock is constant and only the 200-char branch can fire. */
function cadenceGateway(type: ArtifactType, deltas: string[], doneUsage: Usage, clock: { t: number }, tickMs = 0): Gateway {
  const stream = ((_kind: "artifact" | "grounded", system: string) => {
    if (systemToType(system) !== type) throw new Error(`cadenceGateway only serves ${type}`);
    return (async function* () {
      for (const text of deltas) {
        yield { type: "delta", text } as const;
        clock.t += tickMs;
      }
      yield { type: "done", usage: doneUsage, sources: [] } as const;
    })();
  }) as Gateway["stream"];
  const chat = (async () => { throw new Error("chat is not used by the deliver engine"); }) as Gateway["chat"];
  return { chat, stream } as Gateway;
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

const CFG: DeliverCfg = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 1_000_000 };
const u = (input: number, output: number): Usage => ({ input, output });
const done = (usage: Usage, sources: Source[] = []) => ({ usage, sources });

function ctx(over: Partial<DeliverCtx> & Pick<DeliverCtx, "deps" | "sse">): DeliverCtx {
  return { runId: "r1", idea: "A reminder app for solo founders", anonSessionId: "s1", transcript: [], debateTokens: u(0, 0), cfg: CFG, startedAt: 0, ...over };
}

/** SSE event `type` values whose payload names a given artifact (delta/done/failed carry `type`). */
function artifactEventTypes(events: { type: string; payload: unknown }[], artifact: ArtifactType): string[] {
  return events.filter((e) => (e.payload as { type?: string }).type === artifact).map((e) => e.type);
}

const rowFor = (state: { artifacts: Row[] }, type: ArtifactType) => state.artifacts.find((r) => r.type === type);

describe("runDeliver", () => {
  it("TC-029 shape: fans out four artifacts, persists content + tokens, scan grounded, outcome complete", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway, calls } = streamGateway({
      prd: [{ deltas: ["# PRD\n", "problem body"], done: done(u(100, 40)) }],
      scan: [{ deltas: ["# Scan\n", "competitors"], done: done(u(200, 60), [{ title: "Acme", url: "https://acme.test" }]) }],
      copy: [{ deltas: ["# Copy\n", "headline"], done: done(u(80, 30)) }],
      plan: [{ deltas: ["# Plan\n", "slice"], done: done(u(90, 35)) }],
    });
    const outcome = await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 1000 }, sse, debateTokens: u(500, 250) }));

    expect(outcome).toMatchObject({ status: "complete", grounded: true });
    // usage = sum of the four dones (not debate tokens).
    expect(outcome.usage).toEqual(u(100 + 200 + 80 + 90, 40 + 60 + 30 + 35));
    expect(outcome.artifacts).toEqual({ prd: "done", scan: "done", copy: "done", plan: "done" });

    for (const type of ARTIFACT_TYPES) {
      const row = rowFor(state, type)!;
      expect(row.status).toBe("done");
      expect(row.finished_at).toBeTruthy();
    }
    // content_md equals the concatenated deltas — proves the flush cadence reassembles the full text.
    expect(rowFor(state, "prd")!.content_md).toBe("# PRD\nproblem body");
    expect(rowFor(state, "prd")!.tokens_in).toBe(100);
    expect(rowFor(state, "prd")!.tokens_out).toBe(40);
    const scan = rowFor(state, "scan")!;
    expect(scan.grounded).toBe(true);
    expect(scan.sources).toEqual([{ title: "Acme", url: "https://acme.test" }]);

    // The scan was called with kind "grounded"; the others with "artifact".
    expect(calls.find((c) => c.type === "scan")!.kind).toBe("grounded");
    for (const type of ["prd", "copy", "plan"] as const) expect(calls.find((c) => c.type === type)!.kind).toBe("artifact");

    // run.status is emitted once at the start; per artifact the order is …delta…, artifact.done.
    expect(sse.events[0]).toEqual({ type: "run.status", payload: { status: "running", phase: "deliver" } });
    for (const type of ARTIFACT_TYPES) {
      const types = artifactEventTypes(sse.events, type);
      expect(types.at(-1)).toBe("artifact.done");
      expect(types.slice(0, -1).every((t) => t === "artifact.delta")).toBe(true);
      expect(types).toContain("artifact.delta");
    }
    expect(sse.close).not.toHaveBeenCalled(); // the run owns the stream lifecycle, not deliver.
  });

  it("TC-030: grounded scan throws → re-issued ungrounded with the unverified prefix, run still complete", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway, calls } = streamGateway({
      prd: [{ deltas: ["prd"], done: done(u(10, 5)) }],
      scan: [{ throw: new Error("grounding timeout") }, { deltas: ["ungrounded body"], done: done(u(20, 8), [{ title: "ignored", url: "https://x.test" }]) }],
      copy: [{ deltas: ["copy"], done: done(u(10, 5)) }],
      plan: [{ deltas: ["plan"], done: done(u(10, 5)) }],
    });
    const outcome = await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 1000 }, sse }));

    expect(outcome.status).toBe("complete");
    expect(outcome.grounded).toBe(false);
    const scan = rowFor(state, "scan")!;
    expect(String(scan.content_md).startsWith("From memory, unverified — could not reach search.")).toBe(true);
    expect(String(scan.content_md)).toContain("ungrounded body");
    expect(scan.grounded).toBe(false);
    expect(scan.sources).toEqual([]); // fallback drops sources even though the stream reported one.

    const scanCalls = calls.filter((c) => c.type === "scan");
    expect(scanCalls.map((c) => c.kind)).toEqual(["grounded", "artifact"]);
  });

  it("TC-031 (engine half): an artifact that throws twice ends failed while the others finish", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway } = streamGateway({
      prd: [{ deltas: ["prd"], done: done(u(10, 5)) }],
      scan: [{ deltas: ["scan"], done: done(u(10, 5), [{ title: "s", url: "https://s.test" }]) }],
      copy: [{ deltas: ["copy"], done: done(u(10, 5)) }],
      plan: [{ throw: new Error("model error") }, { throw: new Error("model error again") }],
    });
    const outcome = await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 1000 }, sse }));

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("model_error");
    expect(outcome.artifacts).toEqual({ prd: "done", scan: "done", copy: "done", plan: "failed" });
    expect(rowFor(state, "plan")!.status).toBe("failed");
    expect(rowFor(state, "plan")!.finished_at).toBeTruthy();
    // usage excludes the failed artifact (it never emitted done → contributes 0).
    expect(outcome.usage).toEqual(u(30, 15));
    expect(artifactEventTypes(sse.events, "plan").at(-1)).toBe("artifact.failed");
  });

  it("TC-033 (wall half): the deadline aborts an in-flight artifact → reason timeout, done artifacts stay done", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway } = streamGateway({
      prd: [{ deltas: ["prd"], done: done(u(10, 5)) }],
      scan: [{ deltas: ["scan"], done: done(u(10, 5), [{ title: "s", url: "https://s.test" }]) }],
      copy: [{ deltas: ["copy"], done: done(u(10, 5)) }],
      plan: [{ hang: true }],
    });
    // now() far past startedAt+wall → remaining clamps to 0 → the wall timer fires on the next tick,
    // after the three fast artifacts have already settled done.
    const outcome = await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 200_000 }, sse, startedAt: 0 }));

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("timeout");
    expect(outcome.artifacts).toEqual({ prd: "done", scan: "done", copy: "done", plan: "failed" });
    expect(rowFor(state, "plan")!.status).toBe("failed");
    for (const type of ["prd", "scan", "copy"] as const) expect(rowFor(state, type)!.status).toBe("done");
  });

  it("TC-033 (budget half): done usages push the run total over the token cap → reason budget", async () => {
    const { db } = makeDb();
    const sse = sseDouble();
    const { gateway } = streamGateway({
      prd: [{ deltas: ["prd"], done: done(u(200, 0)) }],
      scan: [{ deltas: ["scan"], done: done(u(200, 0), [{ title: "s", url: "https://s.test" }]) }],
      copy: [{ deltas: ["copy"], done: done(u(200, 0)) }],
      plan: [{ hang: true }],
    });
    // debate 700 + prd 200 = 900 (≤ 1000); + scan 200 = 1100 (> 1000) → budget breaker aborts the
    // hanging plan. Wall cap is generous and now() sits at the start so the wall timer never fires.
    const cfg: DeliverCfg = { RUN_WALL_CAP_S: 90, RUN_TOKEN_CAP: 1000 };
    const outcome = await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 0 }, sse, startedAt: 0, debateTokens: u(400, 300), cfg }));

    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("budget");
    expect(outcome.artifacts.plan).toBe("failed");
  });
});

describe("deliverOne", () => {
  it("re-runs a single artifact: streaming → done, returns usage + grounded + sources", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway } = streamGateway({ copy: [{ deltas: ["head", "line"], done: done(u(70, 25)) }] });
    const result = await deliverOne({ type: "copy", idea: "idea", transcript: [], deps: { db, gateway, sink: stubSink(), now: () => 1000 }, sse, runId: "r1", maxOutputTokens: 5000 });

    expect(result).toEqual({ status: "done", usage: u(70, 25), grounded: false, sources: [] });
    const row = rowFor(state, "copy")!;
    expect(row.status).toBe("done");
    expect(row.content_md).toBe("headline");
    expect(row.run_id).toBe("r1");
    expect(artifactEventTypes(sse.events, "copy").at(-1)).toBe("artifact.done");
  });

  it("retries an existing failed row: upsert resets it to streaming and it finishes done", async () => {
    // Seed a prior failed attempt (the retry-endpoint entry state).
    const { db, state } = makeDb([{ run_id: "r1", type: "plan", status: "failed", content_md: "old partial", grounded: false, sources: [], tokens_in: 0, tokens_out: 0, finished_at: "2020-01-01T00:00:00.000Z" }]);
    const sse = sseDouble();
    const { gateway } = streamGateway({ plan: [{ deltas: ["fresh"], done: done(u(11, 3)) }] });
    const result = await deliverOne({ type: "plan", idea: "idea", transcript: [], deps: { db, gateway, sink: stubSink(), now: () => 2000 }, sse, runId: "r1", maxOutputTokens: 5000 });

    expect(result.status).toBe("done");
    expect(state.artifacts).toHaveLength(1); // upsert updated the existing row, no duplicate.
    expect(rowFor(state, "plan")!.content_md).toBe("fresh"); // old partial content was overwritten.
    expect(rowFor(state, "plan")!.status).toBe("done");
  });
});

describe("flush cadence (multi-flush reassembly is lossless and dup-free)", () => {
  /** All artifact.delta payloads for `type`, concatenated in emission order. */
  const streamedText = (events: { type: string; payload: unknown }[], type: ArtifactType) =>
    events.filter((e) => e.type === "artifact.delta" && (e.payload as { type?: string }).type === type).map((e) => (e.payload as { text: string }).text).join("");

  it("char threshold: many deltas cross 200 chars repeatedly → several flushes; content_md == deltas, streamed deltas reassemble it", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const clock = { t: 0 }; // constant clock → only the 200-char branch can fire
    // 12 deltas of 50 chars = 600 chars total → the 200-char rule flushes at deltas 4, 8, 12.
    const deltas = Array.from({ length: 12 }, (_, i) => "x".repeat(49) + String(i % 10));
    const gateway = cadenceGateway("prd", deltas, u(120, 40), clock, 0);
    const result = await deliverOne({ type: "prd", idea: "idea", transcript: [], deps: { db, gateway, sink: stubSink(), now: () => clock.t }, sse, runId: "r1", maxOutputTokens: 5000 });

    expect(result.status).toBe("done");
    const expected = deltas.join("");
    // (a) persisted content_md equals every yielded delta concatenated — no loss, no duplication.
    expect(rowFor(state, "prd")!.content_md).toBe(expected);
    // (b) every streamed artifact.delta payload, concatenated, also equals content_md — the pending
    // buffer resets so each chunk is streamed exactly once.
    expect(streamedText(sse.events, "prd")).toBe(expected);
    // More than one threshold-driven flush fired (not just prefix + final): ≥ 3 delta events.
    const deltaEvents = sse.events.filter((e) => e.type === "artifact.delta").length;
    expect(deltaEvents).toBeGreaterThanOrEqual(3);
  });

  it("time threshold: clock advances 500ms between small deltas → 400ms branch flushes repeatedly, still lossless", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const clock = { t: 0 };
    // 6 small deltas (10 chars, never hitting 200) but +500ms between each → the 400ms branch fires.
    const deltas = Array.from({ length: 6 }, (_, i) => `d${i}` + "-".repeat(8));
    const gateway = cadenceGateway("copy", deltas, u(30, 10), clock, 500);
    const result = await deliverOne({ type: "copy", idea: "idea", transcript: [], deps: { db, gateway, sink: stubSink(), now: () => clock.t }, sse, runId: "r1", maxOutputTokens: 5000 });

    expect(result.status).toBe("done");
    const expected = deltas.join("");
    expect(rowFor(state, "copy")!.content_md).toBe(expected);
    expect(streamedText(sse.events, "copy")).toBe(expected);
    // Several time-driven flushes (each < 200 chars, so only the 400ms branch could have fired them).
    const deltaEvents = sse.events.filter((e) => e.type === "artifact.delta").length;
    expect(deltaEvents).toBeGreaterThanOrEqual(3);
  });
});

describe("column-allowlist guard (offline stand-in for the live PGRST204 bug)", () => {
  it("every persisted artifact key stays within the schema allowlist", async () => {
    const { db, state } = makeDb();
    const sse = sseDouble();
    const { gateway } = streamGateway({
      prd: [{ deltas: ["prd"], done: done(u(10, 5)) }],
      scan: [{ deltas: ["scan"], done: done(u(10, 5), [{ title: "s", url: "https://s.test" }]) }],
      copy: [{ deltas: ["copy"], done: done(u(10, 5)) }],
      plan: [{ deltas: ["plan"], done: done(u(10, 5)) }],
    });
    await runDeliver(ctx({ deps: { db, gateway, sink: stubSink(), now: () => 1000 }, sse }));

    for (const row of state.artifacts) {
      for (const key of Object.keys(row)) expect(ARTIFACT_COLUMNS.has(key)).toBe(true);
    }
  });

  it("the db double rejects an out-of-schema key (the guard actually bites)", async () => {
    const { db } = makeDb();
    const res = await db.from("artifacts").upsert({ run_id: "r1", type: "prd", to: "team" } as Row);
    expect((res as { error: { code?: string } }).error?.code).toBe("PGRST204");
  });
});
