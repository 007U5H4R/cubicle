import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { track, type EventSink } from "@/lib/events";
import type { RunSse } from "./run";

// TSK-08.2 — the concurrency slot guard + live queue (technical-plan A7 + A11 + TC-035). Called by
// POST /api/runs AFTER the run row exists but BEFORE runOne, from inside waitUntil: it either claims a
// slot now, or streams a live `run.status` queue to the connection for up to 90 s and abandons. There
// is no worker and no external queue — the requesting connection IS the queue. Fully injectable
// (db/sink/sse/now/sleep via ctx) — no config()/Date.now()/serviceClient() — so it runs offline
// against an in-memory db double with a fake clock and a clock-advancing sleep.

/** A `running` row whose `started_at` aged past this stops counting toward the cap — a crashed or
 * abandoned run must not hold a slot forever. */
const SLOT_STALE_MS = 180_000; // 3 min
/** Max wall time a connection waits in the queue before giving up and leaving the row `queued`. */
const QUEUE_WAIT_CAP_S = 90;
/** Poll cadence between admission attempts while queued. */
const POLL_MS = 2_000;
/** ETA basis: assumed seconds of slot occupancy per run, for the position→eta estimate. */
const SECONDS_PER_RUN = 70;

export interface SlotCfg {
  RUN_CONCURRENCY_CAP: number;
}

export interface SlotCtx {
  db: SupabaseClient;
  sink: EventSink;
  sse: RunSse;
  runId: string;
  anonSessionId: string | null;
  cfg: SlotCfg;
  now(): number;
  sleep(ms: number): Promise<void>; // injected — prod: setTimeout; tests: advance the clock
}

export interface SlotResult {
  admitted: boolean;
  queued: boolean;
  waited_s: number;
}

/** Count of `running` runs whose `started_at` is newer than the stale cutoff (the live slot holders). */
async function countRunning(db: SupabaseClient, staleCutoffIso: string): Promise<number> {
  const { count, error } = await db.from("runs").select("id", { count: "exact", head: true }).eq("status", "running").gt("started_at", staleCutoffIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/** Count of `queued` runs created before this run — the number of runs ahead of it in line. */
async function countQueuedAhead(db: SupabaseClient, createdAtIso: string): Promise<number> {
  const { count, error } = await db.from("runs").select("id", { count: "exact", head: true }).eq("status", "queued").lt("created_at", createdAtIso);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Claims a concurrency slot for `runId`, or streams a live queue for up to 90 s and abandons.
 *
 * Admit: when live `running` runs are under the cap, claim the slot by setting the row `running` +
 * `started_at = now()` (an optimistic claim — there is no lock; a rare double-admit at the boundary
 * is tolerated per A11 risk 3, absorbed by the cap's headroom) and return admitted. Otherwise stream
 * `run.status { status: "queued", position, eta_s }` each poll until a slot frees; if the wait reaches
 * 90 s, stream `run.status { status: "full" }`, emit `run_queued_abandoned`, and return without
 * changing the row's status (it stays `queued`, so a later resume can re-submit it).
 */
export async function acquireSlot(ctx: SlotCtx): Promise<SlotResult> {
  const { db, sink, sse, runId, anonSessionId, cfg, now, sleep } = ctx;

  const { data: runRow, error: runErr } = await db.from("runs").select("created_at").eq("id", runId).single();
  if (runErr || !runRow) throw new Error(runErr?.message ?? "run not found");
  const createdAt = (runRow as { created_at: string }).created_at;

  const start = now();
  let queued = false;

  for (;;) {
    const running = await countRunning(db, new Date(now() - SLOT_STALE_MS).toISOString());

    if (running < cfg.RUN_CONCURRENCY_CAP) {
      const { error: admitErr } = await db.from("runs").update({ status: "running", started_at: new Date(now()).toISOString() }).eq("id", runId);
      if (admitErr) throw new Error(admitErr.message);
      return { admitted: true, queued, waited_s: Math.round((now() - start) / 1000) };
    }

    const waited = (now() - start) / 1000;
    if (waited >= QUEUE_WAIT_CAP_S) {
      sse.send("run.status", { status: "full" });
      await track(sink, "run_queued_abandoned", { wait_s: Math.round(waited) }, { anonSessionId, runId });
      return { admitted: false, queued: true, waited_s: Math.round(waited) };
    }

    const position = (await countQueuedAhead(db, createdAt)) + 1;
    const eta_s = Math.round((position * SECONDS_PER_RUN) / cfg.RUN_CONCURRENCY_CAP);
    sse.send("run.status", { status: "queued", position, eta_s });
    queued = true;
    await sleep(POLL_MS);
  }
}
