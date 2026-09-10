import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { checkAllowance } from "@/lib/engine/allowance";
import { acquireSlot } from "@/lib/engine/slots";
import { createSse } from "@/lib/engine/sse";
import { runOne } from "@/lib/engine/run";
import { supabaseSink, track } from "@/lib/events";
import { SESSION_COOKIE } from "@/lib/session";
import { serviceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const bodySchema = z.object({ idea: z.string().trim().min(1).max(500), resume_run_id: z.string().uuid().optional() });

/**
 * POST /api/runs — create (or resume) a run and stream it. Two guards run in front of any work:
 * allowance (reject an over-limit caller with 403 before a run is created) and, inside waitUntil,
 * acquireSlot (claim a concurrency slot now, or stream a live queue and maybe abandon). There is no
 * worker — the requesting connection IS the queue, so the slot wait and the run both live in
 * waitUntil, which owns the SSE stream's lifecycle.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "idea_invalid", message: "Tell us the idea in up to 500 characters." }, { status: 400 });
  }

  const anonSessionId = request.cookies.get(SESSION_COOKIE)?.value;
  if (!anonSessionId) {
    return NextResponse.json({ error: "no_session" }, { status: 400 });
  }

  const c = config();
  const db = serviceClient();
  const resumeRunId = parsed.data.resume_run_id;

  // Allowance is skipped on a resume — the queued run it re-submits was already allowed at creation.
  if (!resumeRunId) {
    const a = await checkAllowance({ db, anonSessionId, userId: null, cfg: { RUN_DAILY_CAP: c.RUN_DAILY_CAP }, now: Date.now }); // TKT-18: pass the signed-in userId
    if (!a.ok) {
      return NextResponse.json({ trigger: "limit", scope: a.scope }, { status: 403 });
    }
  }

  let runId: string;
  if (resumeRunId) {
    // Probe-resistant: a missing, foreign, or non-queued run all return the same 404 (like the retry
    // route) so a caller can't distinguish "doesn't exist" from "not yours".
    const { data: existing } = await db.from("runs").select("id, anon_session_id, status").eq("id", resumeRunId).single();
    if (!existing || (existing as { anon_session_id: string | null }).anon_session_id !== anonSessionId || (existing as { status: string }).status !== "queued") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    runId = resumeRunId;
  } else {
    const { data: run, error } = await db
      .from("runs")
      .insert({ anon_session_id: anonSessionId, idea: parsed.data.idea, status: "queued", model_agent: c.MODEL_AGENT, model_orchestrator: c.MODEL_ORCHESTRATOR })
      .select("id")
      .single();
    if (error || !run) {
      return NextResponse.json({ error: "run_create_failed" }, { status: 500 });
    }
    runId = run.id as string;
  }

  const sse = createSse(runId);
  waitUntil(
    (async () => {
      const slot = await acquireSlot({
        db: serviceClient(),
        sink: supabaseSink(),
        sse,
        runId,
        anonSessionId,
        cfg: { RUN_CONCURRENCY_CAP: c.RUN_CONCURRENCY_CAP },
        now: Date.now,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      });
      if (!slot.admitted) {
        sse.close();
        return;
      }
      await track(supabaseSink(), "run_started", { queued: slot.queued }, { anonSessionId, runId });
      await runOne(runId, sse);
    })(),
  );
  return sse.response;
}
