import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// TSK-08.1 — the run allowance checker (technical-plan A7 + Solution-PRD §3 + TC-035/TC-038). Called
// by POST /api/runs BEFORE a run is inserted, so a plain count of existing rows is correct (the new
// run never counts itself). Fully injectable (db/now/cfg via ctx) — no config()/Date.now()/
// process.env/serviceClient() — so it runs offline against an in-memory db double.

export type AllowanceScope = "anonymous" | "user" | "daily";
export type AllowanceResult = { ok: true } | { ok: false; scope: AllowanceScope };

export interface AllowanceCtx {
  db: SupabaseClient; // inject; tests pass a double
  anonSessionId: string;
  userId?: string | null; // present when signed in
  cfg: { RUN_DAILY_CAP: number };
  now(): number; // injected clock — for the UTC-day boundary
}

const ANON_COMPLETE_CAP = 1;
const USER_COMPLETE_CAP = 3;

/** Start of the current UTC day for ctx.now(), as an ISO string, for `created_at >= thatISO`. */
function utcDayStartIso(nowMs: number): string {
  const d = new Date(nowMs);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Count of `complete` runs for this anonymous session. */
async function countAnonComplete(db: SupabaseClient, anonSessionId: string): Promise<number> {
  const { count, error } = await db.from("runs").select("id", { count: "exact", head: true }).eq("anon_session_id", anonSessionId).eq("status", "complete");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Count of `complete` runs owned by this user (includes runs claimed after the fact). */
async function countUserComplete(db: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await db.from("runs").select("id", { count: "exact", head: true }).eq("owner_user_id", userId).eq("status", "complete");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Count of `running`+`complete` runs today (UTC), excluding `[smoke]`-prefixed ideas. */
async function countDailySpend(db: SupabaseClient, todayStartIso: string): Promise<number> {
  const { count, error } = await db
    .from("runs")
    .select("id", { count: "exact", head: true })
    .in("status", ["running", "complete"])
    .gte("created_at", todayStartIso)
    .not("idea", "like", "[smoke]%");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Counts existing runs and returns whether a NEW run is allowed, or the first-violated scope.
 *
 * RULING (check order): per-identity first, then site-wide. Signed in → check `user`; else → check
 * `anonymous`; then always check `daily`. The per-identity scope drives the sign-in-prompt copy
 * (anonymous → "sign in for more", user → "you've used your 3"); daily is the catch-all site guard.
 */
export async function checkAllowance(ctx: AllowanceCtx): Promise<AllowanceResult> {
  const { db, anonSessionId, userId, cfg, now } = ctx;

  if (userId) {
    const userComplete = await countUserComplete(db, userId);
    if (userComplete >= USER_COMPLETE_CAP) return { ok: false, scope: "user" };
  } else {
    const anonComplete = await countAnonComplete(db, anonSessionId);
    if (anonComplete >= ANON_COMPLETE_CAP) return { ok: false, scope: "anonymous" };
  }

  const dailySpend = await countDailySpend(db, utcDayStartIso(now()));
  if (dailySpend >= cfg.RUN_DAILY_CAP) return { ok: false, scope: "daily" };

  return { ok: true };
}
