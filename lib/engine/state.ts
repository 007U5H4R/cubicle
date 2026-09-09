import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Envelope } from "./envelope";

export interface RunStateRun {
  id: string;
  idea: string;
  status: string;
  stop_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  is_shared: boolean;
  share_slug: string | null;
  owner: boolean;
  /** Internal ownership key — the route strips this before responding. */
  anon_session_id: string;
}

export interface ArtifactState {
  status: string;
  content_md: string;
  grounded: boolean;
  sources: unknown[];
}

export interface RunState {
  run: RunStateRun;
  messages: Envelope[];
  artifacts: Record<string, ArtifactState>;
}

/** Reconstructs a run's full state from `runs`, `messages`, and `artifacts`. `owner` always starts false — the caller (route) computes it from the session cookie. */
export async function loadRunState(db: SupabaseClient, runId: string): Promise<RunState | null> {
  const { data: runRow } = await db
    .from("runs")
    .select("id, idea, status, stop_reason, started_at, finished_at, is_shared, share_slug, anon_session_id")
    .eq("id", runId)
    .single();
  if (!runRow) return null;

  const [{ data: messageRows }, { data: artifactRows }] = await Promise.all([
    db.from("messages").select("*").eq("run_id", runId).order("seq", { ascending: true }),
    db.from("artifacts").select("*").eq("run_id", runId),
  ]);

  const artifacts: Record<string, ArtifactState> = {};
  for (const row of (artifactRows ?? []) as { type: string; status: string; content_md: string; grounded: boolean; sources: unknown[] }[]) {
    artifacts[row.type] = { status: row.status, content_md: row.content_md, grounded: row.grounded, sources: row.sources };
  }

  return {
    run: { ...(runRow as Omit<RunStateRun, "owner">), owner: false },
    messages: (messageRows ?? []) as Envelope[],
    artifacts,
  };
}
