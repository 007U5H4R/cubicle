import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { config } from "@/lib/config";
import { createSse } from "@/lib/engine/sse";
import { runOne } from "@/lib/engine/run";
import { supabaseSink, track } from "@/lib/events";
import { SESSION_COOKIE } from "@/lib/session";
import { serviceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const bodySchema = z.object({ idea: z.string().trim().min(1).max(500), resume_run_id: z.string().uuid().optional() });

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
  const { data: run, error } = await serviceClient()
    .from("runs")
    .insert({ anon_session_id: anonSessionId, idea: parsed.data.idea, status: "queued", model_agent: c.MODEL_AGENT, model_orchestrator: c.MODEL_ORCHESTRATOR })
    .select("id")
    .single();
  if (error || !run) {
    return NextResponse.json({ error: "run_create_failed" }, { status: 500 });
  }

  await track(supabaseSink(), "run_started", { queued: false }, { anonSessionId, runId: run.id as string });

  const sse = createSse(run.id as string);
  waitUntil(runOne(run.id as string, sse));
  return sse.response;
}
