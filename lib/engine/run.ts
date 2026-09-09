import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";
import { supabaseSink, track, type EventSink } from "@/lib/events";
import { createGateway, type Gateway } from "@/lib/gateway";
import { realTransport } from "@/lib/gateway/transport";
import { serviceClient } from "@/lib/supabase/server";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import { agentOutputJsonSchema, agentOutputSchema, type Envelope } from "./envelope";
import { costCents } from "./cost";

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

function userTurn(idea: string): string {
  return `IDEA: ${idea}\nTRANSCRIPT: (none yet)\nBRIEF: Open the discussion: frame the problem, the user, and the value, and name one assumption you are unsure of.`;
}

/** The M-001 tracer bullet: one PM call, persisted, streamed over SSE. */
export async function runOne(runId: string, sse: RunSse, deps: RunDeps = defaultDeps()): Promise<void> {
  const { db, gateway, sink, now } = deps;
  const startedAt = now();
  let anonSessionId: string | null = null;
  try {
    const { data: runRow, error: runErr } = await db.from("runs").select("idea, anon_session_id").eq("id", runId).single();
    if (runErr || !runRow) throw new Error(runErr?.message ?? "run not found");
    const idea = (runRow as { idea: string }).idea;
    anonSessionId = (runRow as { anon_session_id: string | null }).anon_session_id;

    const { error: startErr } = await db.from("runs").update({ status: "running", started_at: new Date(startedAt).toISOString() }).eq("id", runId);
    if (startErr) throw new Error(startErr.message);
    sse.send("run.status", { status: "running", phase: "debate", thinking: "pm" });

    const { data: output, usage } = await gateway.chat("agent", ROLE_PREFIX.pm, userTurn(idea), agentOutputSchema, agentOutputJsonSchema);

    const envelope: Envelope = {
      id: crypto.randomUUID(),
      run_id: runId,
      seq: 1,
      from_role: "pm",
      to: output.to,
      to_role: output.to,
      act: output.act,
      subject: output.subject,
      body: output.body,
      reply_to: null,
      hops: 0,
      brief: null,
      created_at: new Date(now()).toISOString(),
    };
    const { error: msgErr } = await db.from("messages").insert(envelope);
    if (msgErr) throw new Error(msgErr.message);
    sse.send("message", envelope);

    const finishedAt = now();
    const wallS = Math.round((finishedAt - startedAt) / 1000);
    const costCentsValue = costCents(usage);
    const { error: doneErr } = await db
      .from("runs")
      .update({ status: "complete", finished_at: new Date(finishedAt).toISOString(), tokens_in: usage.input, tokens_out: usage.output, cost_cents: costCentsValue })
      .eq("id", runId);
    if (doneErr) throw new Error(doneErr.message);
    sse.send("run.done", { status: "complete", wall_s: wallS, tokens: usage.input + usage.output, cost_cents: costCentsValue });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("runs").update({ status: "failed", error: message }).eq("id", runId);
    await track(sink, "run_failed", { phase: "debate", reason: "model_error" }, { anonSessionId, runId });
    sse.send("run.error", { phase: "debate", reason: "model_error", message });
  } finally {
    sse.close();
  }
}
