import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { checkAllowance, type AllowanceCtx } from "./allowance";

type Row = { id: string; anon_session_id?: string; owner_user_id?: string; idea: string; status: string; created_at: string };

// In-memory double for the `runs` count queries this task needs, mirroring @supabase/supabase-js's
// chainable query builder (`.select(...,{count,head}).eq().eq().gte().in().not(...)`), resolving to
// `{ count, error }`. Extends lib/engine/run.test.ts's makeDb style with count/gte/in/not support —
// this task never inserts/updates rows, so only `select` is modelled.
function makeDb(rows: Row[]) {
  function from(name: "runs") {
    if (name !== "runs") throw new Error(`unexpected table: ${name}`);
    return {
      select(cols: string, opts?: { count: "exact"; head: true }) {
        if (cols !== "id") throw new Error(`unexpected select columns: ${cols}`);
        if (!opts?.head) throw new Error("allowance queries must use { count: 'exact', head: true }");
        let filtered = [...rows];
        const builder = {
          eq(col: keyof Row, val: unknown) {
            filtered = filtered.filter((r) => r[col] === val);
            return builder;
          },
          in(col: keyof Row, vals: unknown[]) {
            filtered = filtered.filter((r) => vals.includes(r[col]));
            return builder;
          },
          gte(col: keyof Row, val: string) {
            filtered = filtered.filter((r) => String(r[col]) >= val);
            return builder;
          },
          not(col: keyof Row, op: "like", pattern: string) {
            if (op !== "like") throw new Error(`unsupported not() op: ${op}`);
            const prefix = pattern.replace(/%$/, "");
            filtered = filtered.filter((r) => !String(r[col]).startsWith(prefix));
            return builder;
          },
          then(resolve: (v: { count: number; error: null }) => void) {
            resolve({ count: filtered.length, error: null });
          },
        };
        return builder;
      },
    };
  }
  return { from } as unknown as SupabaseClient;
}

const iso = (utcMs: number) => new Date(utcMs).toISOString();
const DAY1 = Date.UTC(2026, 8, 10, 12, 0, 0); // 2026-09-10T12:00:00Z
const DAY2 = Date.UTC(2026, 8, 11, 1, 0, 0); // next UTC day

function ctx(overrides: Partial<AllowanceCtx> & { rows: Row[] }): AllowanceCtx {
  const { rows, ...rest } = overrides;
  return { db: makeDb(rows), anonSessionId: "s1", cfg: { RUN_DAILY_CAP: 100 }, now: () => DAY1, ...rest };
}

describe("checkAllowance", () => {
  describe("anonymous scope", () => {
    it("admits a session with no runs", async () => {
      const result = await checkAllowance(ctx({ rows: [] }));
      expect(result).toEqual({ ok: true });
    });

    it("blocks a session that already has 1 complete run", async () => {
      const rows: Row[] = [{ id: "r1", anon_session_id: "s1", idea: "idea", status: "complete", created_at: iso(DAY1) }];
      const result = await checkAllowance(ctx({ rows }));
      expect(result).toEqual({ ok: false, scope: "anonymous" });
    });

    it("admits a session whose only run failed (TC-038 — failed doesn't count)", async () => {
      const rows: Row[] = [{ id: "r1", anon_session_id: "s1", idea: "idea", status: "failed", created_at: iso(DAY1) }];
      const result = await checkAllowance(ctx({ rows }));
      expect(result).toEqual({ ok: true });
    });

    it("admits a session with only a queued/running run", async () => {
      const rows: Row[] = [
        { id: "r1", anon_session_id: "s1", idea: "idea", status: "queued", created_at: iso(DAY1) },
        { id: "r2", anon_session_id: "s1", idea: "idea", status: "running", created_at: iso(DAY1) },
      ];
      const result = await checkAllowance(ctx({ rows }));
      expect(result).toEqual({ ok: true });
    });
  });

  describe("user scope", () => {
    it("admits a user with 2 complete runs", async () => {
      const rows: Row[] = [
        { id: "r1", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
        { id: "r2", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
      ];
      const result = await checkAllowance(ctx({ rows, userId: "u1" }));
      expect(result).toEqual({ ok: true });
    });

    it("blocks a user with 3 complete runs, including a claimed one", async () => {
      const rows: Row[] = [
        { id: "r1", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
        { id: "r2", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
        // Claimed after the fact: anon_session_id set on creation, owner_user_id set on claim.
        { id: "r3", anon_session_id: "s0", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
      ];
      const result = await checkAllowance(ctx({ rows, userId: "u1" }));
      expect(result).toEqual({ ok: false, scope: "user" });
    });
  });

  describe("daily scope", () => {
    it("blocks once running+complete runs today reach RUN_DAILY_CAP", async () => {
      const rows: Row[] = [
        { id: "r1", anon_session_id: "other", idea: "idea", status: "complete", created_at: iso(DAY1) },
        { id: "r2", anon_session_id: "other", idea: "idea", status: "running", created_at: iso(DAY1) },
      ];
      const result = await checkAllowance(ctx({ rows, cfg: { RUN_DAILY_CAP: 2 } }));
      expect(result).toEqual({ ok: false, scope: "daily" });
    });

    it("does not count a run created on the prior UTC day", async () => {
      const rows: Row[] = [{ id: "r1", anon_session_id: "other", idea: "idea", status: "complete", created_at: iso(DAY1) }];
      // now() has advanced past the following UTC midnight — yesterday's run drops out of the count.
      const result = await checkAllowance(ctx({ rows, cfg: { RUN_DAILY_CAP: 1 }, now: () => DAY2 }));
      expect(result).toEqual({ ok: true });
    });

    it("excludes [smoke]-prefixed runs from the daily count", async () => {
      const rows: Row[] = [{ id: "r1", anon_session_id: "other", idea: "[smoke] load test", status: "complete", created_at: iso(DAY1) }];
      const result = await checkAllowance(ctx({ rows, cfg: { RUN_DAILY_CAP: 1 } }));
      expect(result).toEqual({ ok: true });
    });
  });

  describe("check order", () => {
    it("returns anonymous when both the anonymous and daily limits are hit (per-identity first)", async () => {
      const rows: Row[] = [{ id: "r1", anon_session_id: "s1", idea: "idea", status: "complete", created_at: iso(DAY1) }];
      const result = await checkAllowance(ctx({ rows, cfg: { RUN_DAILY_CAP: 1 } }));
      expect(result).toEqual({ ok: false, scope: "anonymous" });
    });

    it("returns daily for a signed-in user under their limit once the daily cap is reached", async () => {
      const rows: Row[] = [
        { id: "r1", owner_user_id: "u1", idea: "idea", status: "complete", created_at: iso(DAY1) },
        { id: "r2", anon_session_id: "other", idea: "idea", status: "complete", created_at: iso(DAY1) },
      ];
      const result = await checkAllowance(ctx({ rows, userId: "u1", cfg: { RUN_DAILY_CAP: 2 } }));
      expect(result).toEqual({ ok: false, scope: "daily" });
    });
  });
});
