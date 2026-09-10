import { waitUntil } from "@vercel/functions";
import { type NextRequest, NextResponse } from "next/server";
import { createSse } from "@/lib/engine/sse";
import { authorizeRetry, runRetry } from "@/lib/engine/finalize";
import { defaultDeps, deliverCfg } from "@/lib/engine/run";
import type { ArtifactType } from "@/lib/prompts/headings";
import { SESSION_COOKIE } from "@/lib/session";
import { serviceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * POST /api/runs/[id]/artifact/[type]/retry — re-run one failed desk on an owned run and, if that
 * finishes the pack, complete the run. Authz (the 404/409 decision) happens BEFORE the stream is
 * created, so a foreign/invalid caller gets a plain JSON status and never a stream. The retry work
 * runs in waitUntil and owns the SSE stream's lifecycle (runRetry closes it in a finally).
 */
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; type: string }> }): Promise<Response> {
  const { id, type } = await ctx.params;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const db = serviceClient();

  const authz = await authorizeRetry(db, id, type, cookie);
  if (!authz.ok) {
    if (authz.status === 404) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ error: authz.error }, { status: 409 });
  }

  const sse = createSse(id);
  const startedAtMs = authz.run.started_at ? Date.parse(authz.run.started_at) : Date.now();
  waitUntil(
    runRetry({
      deps: defaultDeps(),
      sse,
      runId: id,
      type: type as ArtifactType,
      idea: authz.run.idea,
      anonSessionId: authz.run.anon_session_id,
      startedAt: startedAtMs,
      cfg: deliverCfg(),
    }),
  );
  return sse.response;
}
