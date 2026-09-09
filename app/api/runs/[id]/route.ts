import { type NextRequest, NextResponse } from "next/server";
import { loadRunState } from "@/lib/engine/state";
import { SESSION_COOKIE } from "@/lib/session";
import { serviceClient } from "@/lib/supabase/server";

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const state = await loadRunState(serviceClient(), id);

  // Owner-user + shared-run checks arrive in TKT-18/19 — for now only the
  // originating anon session may view. Always 404, never 403, so a wrong
  // cookie can't be used to probe whether a run id exists.
  if (!state || !cookie || state.run.anon_session_id !== cookie) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const { anon_session_id: _anonSessionId, ...run } = state.run;
  return NextResponse.json({ ...state, run: { ...run, owner: true } });
}
