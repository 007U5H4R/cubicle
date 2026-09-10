import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventSink } from "@/lib/events";

// TKT-12 Dispatch A — reusable replay-test doubles, extracted from run.test.ts unchanged (TSK-09.2)
// so `scripts/gen-office-fixture.ts` can drive the same in-memory `runOne` without duplicating them.
// This module must stay import-free of "vitest" — `gen-office-fixture.ts` loads it under plain tsx,
// outside the vitest runtime, where `vitest`'s ESM-only package throws on require(). Callers that
// want spy-able functions (run.test.ts, via `vi.fn`) pass their own `mock` wrapper; the default is a
// no-op identity so the doubles work unmodified outside a test runner.
type Mock = <T extends (...args: never[]) => unknown>(fn: T) => T;
const identity: Mock = (fn) => fn;

export type Row = Record<string, unknown>;
export type Table = "runs" | "messages" | "artifacts";

// Real column sets from supabase/migrations/0001_init.sql — insert/upsert/update reject any key
// outside these (mirroring PostgREST's PGRST204), so the `to`-column regression is caught offline.
export const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
  artifacts: new Set(["run_id", "type", "status", "content_md", "grounded", "sources", "tokens_in", "tokens_out", "created_at", "finished_at"]),
};

/**
 * In-memory Supabase double. Writer double (column allowlist + PGRST204) plus a reader that supports
 * loadRunState: select() projects the requested columns, and eq() supports .single(), .order(), and
 * being awaited directly (a thenable that resolves to the filtered rows).
 */
export function makeDb(seed: { runs: Row[]; messages?: Row[]; artifacts?: Row[] }) {
  const state = { runs: [...seed.runs], messages: [...(seed.messages ?? [])], artifacts: [...(seed.artifacts ?? [])] };
  const badKey = (name: Table, patch: Row) => Object.keys(patch).find((k) => !COLUMNS[name].has(k));
  const pgrst204 = (name: Table, col: string) => ({ error: { message: `Could not find the '${col}' column of '${name}' in the schema cache`, code: "PGRST204" } });

  function from(name: Table) {
    const rows = state[name];
    const project = (row: Row, cols: string): Row => {
      if (cols === "*") return { ...row };
      const out: Row = {};
      for (const key of cols.split(",").map((c) => c.trim())) out[key] = row[key];
      return out;
    };
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
      select(cols = "*") {
        return {
          eq(col: string, val: unknown) {
            const matches = () => rows.filter((r) => r[col] === val);
            return {
              single() { const r = rows.find((x) => x[col] === val); return Promise.resolve(r ? { data: project(r, cols), error: null } : { data: null, error: { message: "not found" } }); },
              order(ocol: string, opts?: { ascending?: boolean }) {
                const dir = opts?.ascending === false ? -1 : 1;
                const sorted = [...matches()].sort((a, b) => (Number(a[ocol]) - Number(b[ocol])) * dir).map((r) => project(r, cols));
                return Promise.resolve({ data: sorted, error: null });
              },
              then<T>(resolve: (v: { data: Row[]; error: null }) => T) { return Promise.resolve({ data: matches().map((r) => project(r, cols)), error: null }).then(resolve); },
            };
          },
        };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

export function sseDouble(mock: Mock = identity) {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: mock(() => {}) };
}

export function stubSink(mock: Mock = identity): EventSink { return { insert: mock(async () => {}) }; }
