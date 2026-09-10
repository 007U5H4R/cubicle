import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";
import { supabaseSink, track, type EventSink } from "@/lib/events";
import { createGateway, type Gateway } from "@/lib/gateway";
import { realTransport } from "@/lib/gateway/transport";
import { serviceClient } from "@/lib/supabase/server";
import { costCents } from "./cost";
import { runDebate, type DebateCfg } from "./debate";

/** Structural subset of createSse()'s return that run.ts needs — sse.ts (TSK-04.1) satisfies this. */
export interface RunSse {
  send(type: string, payload: unknown): void;
  close(): void;
}

export interface RunDeps {
  db: SupabaseClient;
  gateway: Gateway;
  sink: EventSink;
  now(): number;
}

export function defaultDeps(): RunDeps {
  const c = config();
  return {
    db: serviceClient(),
    gateway: createGateway(realTransport(c.GEMINI_API_KEY), { agent: c.MODEL_AGENT, orchestrator: c.MODEL_ORCHESTRATOR }),
    sink: supabaseSink(),
    now: () => Date.now(),
  };
}

/** Debate caps pulled from config — separated so runOne stays injectable in tests (which pass an
 * explicit cfg and never touch process env via config()). */
export function debateCfg(): DebateCfg {
  const c = config();
  return { DEBATE_MSG_CAP: c.DEBATE_MSG_CAP, DEBATE_WALL_CAP_S: c.DEBATE_WALL_CAP_S, RUN_TOKEN_CAP: c.RUN_TOKEN_CAP };
}

/**
 * Runs one queued run: load it, mark it running, drive the §5 debate loop (delegated to
 * runDebate), then mark it complete with wall/tokens/cost. On any failure the run is marked failed
 * and exactly one run_failed event + one run.error SSE are emitted; the SSE stream is always closed.
 */
export async function runOne(runId: string, sse: RunSse, deps: RunDeps = defaultDeps(), cfg: DebateCfg = debateCfg()): Promise<void> {
  const { db, sink, now } = deps;
  const startedAt = now();
  let anonSessionId: string | null = null;
  try {
    const { data: runRow, error: runErr } = await db.from("runs").select("idea, anon_session_id").eq("id", runId).single();
    if (runErr || !runRow) throw new Error(runErr?.message ?? "run not found");
    const idea = (runRow as { idea: string }).idea;
    anonSessionId = (runRow as { anon_session_id: string | null }).anon_session_id;

    const { error: startErr } = await db.from("runs").update({ status: "running", started_at: new Date(startedAt).toISOString() }).eq("id", runId);
    if (startErr) throw new Error(startErr.message);

    // The debate phase streams its own run.status/message (and steer) events and emits
    // debate_completed. anon_session_id never rides on a message row — it stays with the run/event.
    const outcome = await runDebate({ runId, idea, anonSessionId, deps, sse, cfg, startedAt });

    // TODO(task-7): insert the deliver phase here — grounded competitor scan + artifact pack —
    // between debate_completed and run completion. Until then the run completes after the debate.

    const finishedAt = now();
    const wallS = Math.round((finishedAt - startedAt) / 1000);
    const { input: tokensIn, output: tokensOut } = outcome.usage;
    const costCentsValue = costCents(outcome.usage);
    const { error: doneErr } = await db
      .from("runs")
      .update({ status: "complete", finished_at: new Date(finishedAt).toISOString(), stop_reason: outcome.stop_reason, tokens_in: tokensIn, tokens_out: tokensOut, cost_cents: costCentsValue })
      .eq("id", runId);
    if (doneErr) throw new Error(doneErr.message);
    sse.send("run.done", { status: "complete", wall_s: wallS, tokens: tokensIn + tokensOut, cost_cents: costCentsValue });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("runs").update({ status: "failed", error: message }).eq("id", runId);
    await track(sink, "run_failed", { phase: "debate", reason: "model_error" }, { anonSessionId, runId });
    sse.send("run.error", { phase: "debate", reason: "model_error", message });
  } finally {
    sse.close();
  }
}
