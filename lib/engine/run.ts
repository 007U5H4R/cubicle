import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";
import { supabaseSink, track, type EventSink } from "@/lib/events";
import { createGateway, type Gateway } from "@/lib/gateway";
import { realTransport } from "@/lib/gateway/transport";
import { serviceClient } from "@/lib/supabase/server";
import { runDebate, type DebateCfg } from "./debate";
import { runDeliver, type DeliverCfg } from "./deliver";
import { finalizeDeliver } from "./finalize";

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

/** Deliver caps pulled from config — separated (like debateCfg) so runOne and the retry route stay
 * injectable in tests (which pass an explicit cfg and never touch process env via config()). */
export function deliverCfg(): DeliverCfg {
  const c = config();
  return { RUN_WALL_CAP_S: c.RUN_WALL_CAP_S, RUN_TOKEN_CAP: c.RUN_TOKEN_CAP };
}

/**
 * Runs one queued run: load it, mark it running, drive the §5 debate loop (delegated to
 * runDebate), then mark it complete with wall/tokens/cost. On any failure the run is marked failed
 * and exactly one run_failed event + one run.error SSE are emitted; the SSE stream is always closed.
 */
export async function runOne(runId: string, sse: RunSse, deps: RunDeps = defaultDeps(), cfg: DebateCfg = debateCfg(), cfgDeliver: DeliverCfg = deliverCfg()): Promise<void> {
  const { db, sink, now } = deps;
  const startedAt = now();
  let anonSessionId: string | null = null;
  // Which phase an unexpected throw is attributed to. Set to "deliver" once runDebate returns, so a
  // throw during deliver/finalize is labelled deliver, a debate throw stays debate. Normal deliver
  // failures resolve through finalizeDeliver (runDeliver is designed not to throw), not this catch.
  let phase: "debate" | "deliver" = "debate";
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
    phase = "deliver";

    // §A6 deliver phase: fan out the four artifact calls, then finalize the run. finalizeDeliver is
    // the sole owner of run completion (runs row + pack_completed/run.done or run_failed/run.error) —
    // this function's catch must not also write, or a failed run would emit two run_failed events.
    const deliver = await runDeliver({
      runId,
      idea,
      anonSessionId,
      transcript: outcome.messages,
      debateTokens: outcome.usage,
      deps,
      sse,
      cfg: cfgDeliver,
      startedAt,
    });
    await finalizeDeliver({ deps, sse, runId, anonSessionId, startedAt, stopReason: outcome.stop_reason, debateTokens: outcome.usage, deliver });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // SEC-002: the raw error may carry internal details (stack fragments, upstream error text) —
    // log it server-side only and send a fixed generic string to the client (mirrors
    // finalize.ts's failed-path SSE, which never sends raw error text either).
    console.error(`runOne(${runId}) failed at phase=${phase}:`, e);
    await db.from("runs").update({ status: "failed", error: message }).eq("id", runId);
    await track(sink, "run_failed", { phase, reason: "model_error" }, { anonSessionId, runId });
    sse.send("run.error", { phase, reason: "model_error", message: "Something went wrong running this desk." });
  } finally {
    sse.close();
  }
}
