import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Usage } from "@/lib/gateway";
import { track } from "@/lib/events";
import { ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { costCents } from "./cost";
import { deliverOne, type DeliverCfg, type DeliverOutcome } from "./deliver";
import type { Envelope } from "./envelope";
import type { RunDeps, RunSse } from "./run";

// TSK-07.4 — the run-level finalize + retry logic that closes out the deliver phase. This is the
// only module that turns a DeliverOutcome into the run's completion (runs row + pack_completed /
// run.done, or run_failed / run.error) and that owns the per-desk retry work. Like deliver.ts it is
// fully injectable (deps + sse, no config()/Date.now()/process.env), so it runs offline against
// in-memory doubles, and it is vendor-isolated: it only touches the Gateway via deliverOne.

const zeroPlus = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output });
const wallSeconds = (nowMs: number, startedAtMs: number): number => Math.round((nowMs - startedAtMs) / 1000);

/**
 * Turn the fan-out's DeliverOutcome into the run's terminal state. Called by run.ts once, right
 * after runDeliver. It is the sole owner of run completion — run.ts's catch must not also write.
 * Persists the summed debate+deliver tokens/cost even on failure (the spend happened).
 */
export async function finalizeDeliver(args: {
  deps: RunDeps;
  sse: RunSse;
  runId: string;
  anonSessionId: string | null;
  startedAt: number;
  stopReason: string;
  debateTokens: Usage;
  deliver: DeliverOutcome;
}): Promise<void> {
  const { deps, sse, runId, anonSessionId, startedAt, stopReason, debateTokens, deliver } = args;
  const { db, sink, now } = deps;

  const total = zeroPlus(debateTokens, deliver.usage);
  const finishedAtMs = now();
  const wallS = wallSeconds(finishedAtMs, startedAt);
  const cost = costCents(total);
  const finishedAt = new Date(finishedAtMs).toISOString();
  const tokens = total.input + total.output;

  if (deliver.status === "complete") {
    const { error } = await db
      .from("runs")
      .update({ status: "complete", finished_at: finishedAt, stop_reason: stopReason, tokens_in: total.input, tokens_out: total.output, cost_cents: cost })
      .eq("id", runId);
    if (error) throw new Error(error.message);
    await track(sink, "pack_completed", { wall_s: wallS, tokens, grounded: deliver.grounded }, { anonSessionId, runId });
    sse.send("run.done", { status: "complete", wall_s: wallS, tokens, cost_cents: cost });
    return;
  }

  // failed — reason is always present when status === "failed" (deliver.ts guarantees it).
  const reason = deliver.reason ?? "model_error";
  const { error } = await db
    .from("runs")
    .update({ status: "failed", finished_at: finishedAt, stop_reason: stopReason, tokens_in: total.input, tokens_out: total.output, cost_cents: cost, error: `deliver failed: ${reason}` })
    .eq("id", runId);
  if (error) throw new Error(error.message);
  await track(sink, "run_failed", { phase: "deliver", reason }, { anonSessionId, runId });
  sse.send("run.error", { phase: "deliver", reason });
}

/**
 * After a successful single-desk retry, complete the run iff all four artifacts are now `done`.
 * Reads the four artifact rows; if every one is `done`, flips the run to `complete` (finished_at
 * only — tokens/cost were already re-summed by runRetry) and emits pack_completed / run.done with
 * `grounded` taken from the scan row. Otherwise returns false with no writes: the run stays failed.
 */
export async function completeRunIfAllDone(args: {
  deps: RunDeps;
  sse: RunSse;
  runId: string;
  anonSessionId: string | null;
}): Promise<boolean> {
  const { deps, sse, runId, anonSessionId } = args;
  const { db, sink, now } = deps;

  const { data: artifacts, error: artErr } = await db.from("artifacts").select("type, status, grounded").eq("run_id", runId);
  if (artErr) throw new Error(artErr.message);
  const rows = (artifacts ?? []) as { type: ArtifactType; status: string; grounded: boolean }[];
  const allDone = ARTIFACT_TYPES.every((t) => rows.find((r) => r.type === t)?.status === "done");
  if (!allDone) return false;

  const { data: run, error: runErr } = await db.from("runs").select("started_at, tokens_in, tokens_out, cost_cents").eq("id", runId).single();
  if (runErr || !run) throw new Error(runErr?.message ?? "run not found");
  const runRow = run as { started_at: string | null; tokens_in: number; tokens_out: number; cost_cents: number };

  const startedAtMs = runRow.started_at ? Date.parse(runRow.started_at) : now();
  const finishedAtMs = now();
  const wallS = wallSeconds(finishedAtMs, startedAtMs);
  const grounded = rows.find((r) => r.type === "scan")?.grounded === true;

  const { error: doneErr } = await db.from("runs").update({ status: "complete", finished_at: new Date(finishedAtMs).toISOString() }).eq("id", runId);
  if (doneErr) throw new Error(doneErr.message);

  const tokens = runRow.tokens_in + runRow.tokens_out;
  await track(sink, "pack_completed", { wall_s: wallS, tokens, grounded }, { anonSessionId, runId });
  sse.send("run.done", { status: "complete", wall_s: wallS, tokens, cost_cents: runRow.cost_cents });
  return true;
}

export type AuthzResult =
  | { ok: true; run: { id: string; idea: string; anon_session_id: string | null; started_at: string | null } }
  | { ok: false; status: 404 }
  | { ok: false; status: 409; error: "not_failed" };

/**
 * Owner + state gate for the retry route (TC-032). Always 404 (never 403) for an unknown type,
 * absent cookie, unknown run, or foreign owner — so a wrong cookie cannot probe run existence,
 * mirroring app/api/runs/[id]/route.ts. An owned run whose target artifact is missing or not
 * `failed` is 409 not_failed. Only a genuinely-failed artifact on an owned run proceeds.
 */
export async function authorizeRetry(db: SupabaseClient, runId: string, type: string, cookie: string | undefined): Promise<AuthzResult> {
  if (!ARTIFACT_TYPES.includes(type as ArtifactType) || !cookie) return { ok: false, status: 404 };

  const { data: run, error: runErr } = await db.from("runs").select("id, idea, anon_session_id, started_at").eq("id", runId).single();
  if (runErr || !run) return { ok: false, status: 404 };
  const runRow = run as { id: string; idea: string; anon_session_id: string | null; started_at: string | null };
  if (runRow.anon_session_id !== cookie) return { ok: false, status: 404 };

  const { data: artifact } = await db.from("artifacts").select("status").eq("run_id", runId).eq("type", type).single();
  if (!artifact || (artifact as { status: string }).status !== "failed") return { ok: false, status: 409, error: "not_failed" };

  return { ok: true, run: runRow };
}

/**
 * Re-run one failed desk (driven from the retry route's waitUntil, and unit-tested directly). Owns
 * its own SSE stream (closed in finally) — unlike runDeliver, which the run route owns. Emits no
 * second run_failed: a still-failing retry leaves the run failed and the original run_failed stands.
 */
export async function runRetry(args: {
  deps: RunDeps;
  sse: RunSse;
  runId: string;
  type: ArtifactType;
  idea: string;
  anonSessionId: string | null;
  startedAt: number;
  cfg: DeliverCfg;
}): Promise<void> {
  const { deps, sse, runId, type, idea, anonSessionId, cfg } = args;
  const { db } = deps;

  try {
    const { data: msgs, error: msgErr } = await db.from("messages").select("*").eq("run_id", runId).order("seq", { ascending: true });
    if (msgErr) throw new Error(msgErr.message);
    const transcript = (msgs ?? []) as Envelope[];

    // RULING: a retry is a recovery path, so the desk gets a fresh full desk-share of the token cap
    // (RUN_TOKEN_CAP / 4), independent of prior run spend — see the report. No shared wall/abort on a
    // single-desk retry; the route's maxDuration bounds it, so `signal` is left undefined.
    const maxOutputTokens = Math.floor(cfg.RUN_TOKEN_CAP / 4);

    const one = await deliverOne({ type, idea, transcript, deps, sse, runId, maxOutputTokens });

    // Fold the retry's spend into the run row (read-modify-write; deliverOne already persisted the
    // artifact's own tokens). Done or failed, the spend happened.
    const { data: run, error: runErr } = await db.from("runs").select("tokens_in, tokens_out").eq("id", runId).single();
    if (runErr || !run) throw new Error(runErr?.message ?? "run not found");
    const prev = run as { tokens_in: number; tokens_out: number };
    const tokensIn = prev.tokens_in + one.usage.input;
    const tokensOut = prev.tokens_out + one.usage.output;
    const { error: updErr } = await db
      .from("runs")
      .update({ tokens_in: tokensIn, tokens_out: tokensOut, cost_cents: costCents({ input: tokensIn, output: tokensOut }) })
      .eq("id", runId);
    if (updErr) throw new Error(updErr.message);

    // Only a successful desk can complete the set. A still-failing desk leaves the run failed and
    // emits no second run_failed (deliverOne already streamed artifact.failed for it).
    if (one.status === "done") await completeRunIfAllDone({ deps, sse, runId, anonSessionId });
  } finally {
    sse.close();
  }
}
