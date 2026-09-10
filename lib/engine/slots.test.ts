import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { EventSink } from "@/lib/events";
import { acquireSlot, type SlotCtx } from "./slots";

type Row = { id: string; anon_session_id?: string | null; idea?: string; status: string; created_at: string; started_at?: string | null };

// In-memory double for the `runs` queries acquireSlot needs, mirroring @supabase/supabase-js's
// chainable builder. Extends run.test.ts's makeDb style with the two count queries this task adds —
// `.select("id",{count,head}).eq().gt()` (running-with-stale-guard) and `.eq().lt()` (queued-before) —
// plus the `.select("created_at").eq().single()` created_at read and the admit `.update().eq()`.
function makeDb(rows: Row[]) {
  const state = { runs: rows };
  function from(name: "runs") {
    if (name !== "runs") throw new Error(`unexpected table: ${name}`);
    return {
      update(patch: Partial<Row>) {
        return {
          eq(col: keyof Row, val: unknown) {
            const row = state.runs.find((r) => r[col] === val);
            if (row) Object.assign(row, patch);
            return Promise.resolve({ error: null });
          },
        };
      },
      select(cols: string, opts?: { count: "exact"; head: true }) {
        if (opts?.head) {
          // Count query: chainable eq/gt/lt, resolving (thenable) to { count, error }.
          let filtered = [...state.runs];
          const builder = {
            eq(col: keyof Row, val: unknown) { filtered = filtered.filter((r) => r[col] === val); return builder; },
            gt(col: keyof Row, val: string) { filtered = filtered.filter((r) => r[col] != null && String(r[col]) > val); return builder; },
            lt(col: keyof Row, val: string) { filtered = filtered.filter((r) => r[col] != null && String(r[col]) < val); return builder; },
            then(resolve: (v: { count: number; error: null }) => void) { resolve({ count: filtered.length, error: null }); },
          };
          return builder;
        }
        // Single-row read: `.eq(col,val).single()`.
        return {
          eq(col: keyof Row, val: unknown) {
            return {
              single() {
                const row = state.runs.find((r) => r[col] === val);
                return Promise.resolve(row ? { data: row, error: null } : { data: null, error: { message: "not found" } });
              },
            };
          },
        };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): { sink: EventSink; calls: { name: string; props: Record<string, unknown> }[] } {
  const calls: { name: string; props: Record<string, unknown> }[] = [];
  return { sink: { insert: vi.fn(async (row) => { calls.push({ name: row.name, props: row.props }); }) }, calls };
}

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.UTC(2026, 8, 10, 12, 0, 0);

/** Build a SlotCtx over a fake clock. `sleep` advances the clock by the ms it's asked to wait and, on
 * the K-th call, runs `onNthSleep` (used to free a slot mid-queue) — no real timers. */
function makeCtx(opts: {
  rows: Row[];
  runId: string;
  cap: number;
  onSleep?: (state: { runs: Row[] }, sleepCount: number) => void;
}): { ctx: SlotCtx; sse: ReturnType<typeof sseDouble>; state: { runs: Row[] }; calls: { name: string; props: Record<string, unknown> }[]; clock: () => number } {
  const { db, state } = makeDb(opts.rows);
  const sse = sseDouble();
  const { sink, calls } = stubSink();
  let clock = T0;
  let sleepCount = 0;
  const ctx: SlotCtx = {
    db,
    sink,
    sse,
    runId: opts.runId,
    anonSessionId: "s1",
    cfg: { RUN_CONCURRENCY_CAP: opts.cap },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleepCount += 1;
      opts.onSleep?.(state, sleepCount);
    },
  };
  return { ctx, sse, state, calls, clock: () => clock };
}

const thisRun = (created_at: string): Row => ({ id: "r1", anon_session_id: "s1", idea: "idea", status: "queued", created_at });

describe("acquireSlot", () => {
  it("admits immediately when running count is under the cap, streaming no queue frames", async () => {
    const { ctx, sse, state } = makeCtx({ rows: [thisRun(iso(T0))], runId: "r1", cap: 10 });
    const result = await acquireSlot(ctx);

    expect(result).toEqual({ admitted: true, queued: false, waited_s: 0 });
    expect(state.runs[0]).toMatchObject({ status: "running", started_at: iso(T0) });
    expect(sse.events).toHaveLength(0);
  });

  it("does not count a running row whose started_at aged past the 3-min stale guard (admits at cap)", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      // The only other run is 'running' but started 4 min ago — stale, so it holds no slot.
      { id: "stale", status: "running", created_at: iso(T0 - 300_000), started_at: iso(T0 - 240_000) },
    ];
    const { ctx, sse, state } = makeCtx({ rows, runId: "r1", cap: 1 });
    const result = await acquireSlot(ctx);

    expect(result).toEqual({ admitted: true, queued: false, waited_s: 0 });
    expect(state.runs.find((r) => r.id === "r1")).toMatchObject({ status: "running" });
    expect(sse.events).toHaveLength(0);
  });

  it("queues while the cap is full, then admits once a slot frees (queued:true)", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      { id: "hold", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
    ];
    // After the 2nd poll, free the held slot.
    const { ctx, sse, state } = makeCtx({
      rows,
      runId: "r1",
      cap: 1,
      onSleep: (s, n) => { if (n === 2) { const h = s.runs.find((r) => r.id === "hold"); if (h) h.status = "complete"; } },
    });
    const result = await acquireSlot(ctx);

    expect(result).toMatchObject({ admitted: true, queued: true });
    expect(state.runs.find((r) => r.id === "r1")).toMatchObject({ status: "running" });
    // Two queue frames streamed before admission (polls 1 and 2), each a run.status queued.
    const queueFrames = sse.events.filter((e) => e.type === "run.status");
    expect(queueFrames).toHaveLength(2);
    expect(queueFrames[0]).toMatchObject({ type: "run.status", payload: { status: "queued", position: 1 } });
  });

  it("computes eta_s = round(position × 70 / cap): position 1 cap 1 → 70", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      { id: "hold", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
    ];
    const { ctx, sse } = makeCtx({
      rows,
      runId: "r1",
      cap: 1,
      onSleep: (s, n) => { if (n === 1) { const h = s.runs.find((r) => r.id === "hold"); if (h) h.status = "complete"; } },
    });
    await acquireSlot(ctx);

    const frame = sse.events.find((e) => e.type === "run.status");
    expect(frame).toMatchObject({ payload: { status: "queued", position: 1, eta_s: 70 } });
  });

  it("computes eta_s: position 3 cap 2 → 105 (TC-035)", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      // Two queued runs created before this one → position 3.
      { id: "q1", status: "queued", created_at: iso(T0 - 3_000) },
      { id: "q2", status: "queued", created_at: iso(T0 - 2_000) },
      // Cap 2, both slots held, freed after poll 1.
      { id: "h1", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
      { id: "h2", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
    ];
    const { ctx, sse } = makeCtx({
      rows,
      runId: "r1",
      cap: 2,
      onSleep: (s, n) => { if (n === 1) for (const id of ["h1", "h2"]) { const h = s.runs.find((r) => r.id === id); if (h) h.status = "complete"; } },
    });
    await acquireSlot(ctx);

    const frame = sse.events.find((e) => e.type === "run.status");
    expect(frame).toMatchObject({ payload: { status: "queued", position: 3, eta_s: 105 } });
  });

  it("abandons after 90 s when the cap never frees: streams full, emits run_queued_abandoned once, leaves the row queued", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      { id: "hold", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
    ];
    const { ctx, sse, state, calls } = makeCtx({ rows, runId: "r1", cap: 1 }); // never frees
    const result = await acquireSlot(ctx);

    expect(result).toEqual({ admitted: false, queued: true, waited_s: 90 });
    // Row untouched — still queued so a resume can re-submit it.
    expect(state.runs.find((r) => r.id === "r1")).toMatchObject({ status: "queued" });
    const full = sse.events.filter((e) => (e.payload as { status?: string }).status === "full");
    expect(full).toHaveLength(1);
    const abandoned = calls.filter((c) => c.name === "run_queued_abandoned");
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0].props).toMatchObject({ wait_s: 90 });
  });

  it("counts queued runs created before this run for position: 2 ahead → position 3", async () => {
    const rows: Row[] = [
      thisRun(iso(T0)),
      { id: "q1", status: "queued", created_at: iso(T0 - 3_000) },
      { id: "q2", status: "queued", created_at: iso(T0 - 2_000) },
      // A queued run created AFTER this one must not count toward position.
      { id: "q3", status: "queued", created_at: iso(T0 + 1_000) },
      { id: "hold", status: "running", created_at: iso(T0 - 1_000), started_at: iso(T0 - 1_000) },
    ];
    const { ctx, sse } = makeCtx({
      rows,
      runId: "r1",
      cap: 1,
      onSleep: (s, n) => { if (n === 1) { const h = s.runs.find((r) => r.id === "hold"); if (h) h.status = "complete"; } },
    });
    await acquireSlot(ctx);

    const frame = sse.events.find((e) => e.type === "run.status");
    expect(frame).toMatchObject({ payload: { position: 3 } });
  });
});
