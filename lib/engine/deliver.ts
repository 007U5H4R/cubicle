import "server-only";
import type { Source, Usage } from "@/lib/gateway";
import { buildDispatch } from "@/lib/prompts/dispatch";
import { ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import type { Envelope } from "./envelope";
import type { RunDeps, RunSse } from "./run";

// TSK-07.2 + TSK-07.3 — the §A6 deliver phase engine. After the debate ends the run fans out four
// parallel artifact calls (PM→prd, Researcher→scan [grounded], Designer→copy, Developer→plan),
// streaming each as markdown and persisting to the `artifacts` table under one wall/token deadline.
// This module is the phase engine only: it never wires into run.ts, never touches the `runs` row,
// and emits no pack_completed / run.done / run_failed — those are the run-level finalize's job. It
// is fully injectable (deps + clock) so it runs offline against in-memory doubles, and it is
// vendor-isolated: it only touches the injected Gateway, never a model SDK.

export interface DeliverCfg {
  RUN_WALL_CAP_S: number;
  RUN_TOKEN_CAP: number;
}

export interface DeliverCtx {
  runId: string;
  idea: string;
  anonSessionId: string | null; // carried for symmetry; this module emits no events, so it is unused
  transcript: Envelope[]; // debate messages, already in seq order
  debateTokens: Usage; // tokens already spent by the debate (for the budget split)
  deps: RunDeps;
  sse: RunSse;
  cfg: DeliverCfg;
  startedAt: number; // run start (deps.now() basis); the wall cap is measured from here
}

export type DeliverReason = "timeout" | "budget" | "model_error";

export interface DeliverOutcome {
  status: "complete" | "failed";
  reason?: DeliverReason; // present only when status === "failed"
  grounded: boolean; // whether the scan ended grounded
  usage: Usage; // deliver-phase tokens summed across the four calls
  artifacts: Record<ArtifactType, "done" | "failed">;
}

/** The §A6 fallback prefix prepended to an ungrounded scan when Google Search could not be reached.
 * Exact literal (U+2014 em dash, two trailing newlines) — do not paraphrase. */
const UNVERIFIED_PREFIX = "From memory, unverified — could not reach search.\n\n";

/** Persist-and-stream flush cadence (§A6): flush whenever this many chars have accumulated OR this
 * many ms have elapsed since the last flush, whichever comes first. */
const FLUSH_CHARS = 200;
const FLUSH_MS = 400;

const ZERO_USAGE: Usage = { input: 0, output: 0 };

/**
 * Distinguishable abort reason the wall/token breakers raise on the shared controller. `runDeliver`
 * reads `controller.signal.reason` after the fan-out settles to tell timeout from budget apart —
 * GatewayError does not carry the run-level reason, so we own this sentinel. Module-private.
 */
class DeliverAbort extends Error {
  constructor(public readonly reason: "timeout" | "budget") {
    super(`deliver aborted: ${reason}`);
    this.name = "DeliverAbort";
  }
}

/** Result of one `deliverOne` call (also the retry endpoint's return shape in TSK-07.4). */
type OneResult = { status: "done" | "failed"; usage: Usage; grounded: boolean; sources: Source[] };

/**
 * Re-run ONE artifact: upsert its row to `streaming`, stream+persist its markdown, and settle it to
 * `done`/`failed`. Handles the scan's grounded→ungrounded fallback and the single non-grounding
 * retry itself. Never rejects — a failure resolves to `{ status: "failed" }` so a fan-out over these
 * never has one call reject the whole batch. Emits `artifact.delta` / `artifact.done` /
 * `artifact.failed` (never `run.status` — that is the phase-start event, owned by `runDeliver`).
 */
export async function deliverOne(args: {
  type: ArtifactType;
  idea: string;
  transcript: Envelope[];
  deps: RunDeps;
  sse: RunSse;
  runId: string;
  maxOutputTokens: number;
  signal?: AbortSignal;
}): Promise<OneResult> {
  const { type, idea, transcript, deps, sse, runId, maxOutputTokens, signal } = args;
  const { db, gateway, now } = deps;
  const { system, user } = buildDispatch(type, idea, transcript);

  // A cap abort (wall/budget) on the shared signal is terminal — it must NOT be swallowed as a
  // grounding failure that re-issues, nor retried; it goes straight to `failed`.
  const abortedByCap = () => signal?.aborted === true;

  const match = () => ({ run_id: runId, type });

  async function persistFailed(): Promise<OneResult> {
    await db
      .from("artifacts")
      .update({ status: "failed", finished_at: new Date(now()).toISOString() })
      .match(match());
    sse.send("artifact.failed", { type });
    return { status: "failed", usage: ZERO_USAGE, grounded: false, sources: [] };
  }

  async function persistDone(usage: Usage, sources: Source[], grounded: boolean): Promise<OneResult> {
    await db
      .from("artifacts")
      .update({
        status: "done",
        tokens_in: usage.input,
        tokens_out: usage.output,
        grounded,
        sources,
        finished_at: new Date(now()).toISOString(),
      })
      .match(match());
    sse.send("artifact.done", { type, grounded, sources });
    return { status: "done", usage, grounded, sources };
  }

  /**
   * Run one streaming attempt to completion, persisting `content_md` and streaming `artifact.delta`
   * on the buffer/flush cadence, and returning the `done` payload. Throws if the stream throws
   * (timeout/abort/transient). `prefix` seeds the buffer (the ungrounded-fallback line); each attempt
   * starts its buffer fresh so a retry overwrites any partial content from the prior attempt.
   */
  async function streamAttempt(kind: "artifact" | "grounded", prefix: string): Promise<{ usage: Usage; sources: Source[] }> {
    let full = prefix; // whole markdown so far (persisted to content_md on every flush)
    let pending = prefix; // chars streamed since the last flush (the artifact.delta payload)
    let lastFlushAt = now();

    const flush = async () => {
      const { error } = await db.from("artifacts").update({ content_md: full }).match(match());
      if (error) throw new Error(error.message);
      if (pending.length > 0) sse.send("artifact.delta", { type, text: pending });
      pending = "";
      lastFlushAt = now();
    };

    if (prefix.length > 0) await flush(); // stream the fallback line promptly

    for await (const chunk of gateway.stream(kind, system, user, { signal, maxOutputTokens })) {
      if (chunk.type === "delta") {
        full += chunk.text;
        pending += chunk.text;
        if (pending.length >= FLUSH_CHARS || now() - lastFlushAt >= FLUSH_MS) await flush();
      } else {
        await flush(); // final flush of any remainder before marking done
        return { usage: chunk.usage, sources: chunk.sources };
      }
    }
    // A stream that ends without a `done` event is a protocol violation — treat it as a failure so
    // the retry/failed path handles it rather than silently returning a half-written artifact.
    throw new Error(`${type} stream ended without a done event`);
  }

  // Upsert to streaming (insert if absent; the retry path resets an existing failed row). Reset the
  // content/outcome columns so a retry starts clean. Persist only allowlisted columns.
  const { error: upsertErr } = await db
    .from("artifacts")
    .upsert(
      { run_id: runId, type, status: "streaming", content_md: "", grounded: false, sources: [], tokens_in: 0, tokens_out: 0, finished_at: null },
      { onConflict: "run_id,type" },
    );
  if (upsertErr) throw new Error(upsertErr.message);

  // Scan only: first attempt is grounded. ANY throw from the grounded attempt (except a cap abort)
  // is a grounding failure → fall back to an ungrounded re-issue with the unverified prefix. The
  // fallback is separate from the general retry: a grounded failure always falls back, never retries
  // grounded, and the ungrounded re-issue then still gets its own one retry below.
  let attemptKind: "artifact" | "grounded" = type === "scan" ? "grounded" : "artifact";
  let prefix = "";
  let grounded = type === "scan";

  if (type === "scan") {
    try {
      const { usage, sources } = await streamAttempt("grounded", "");
      return await persistDone(usage, sources, true);
    } catch {
      if (abortedByCap()) return await persistFailed();
      attemptKind = "artifact";
      prefix = UNVERIFIED_PREFIX;
      grounded = false;
    }
  }

  // General attempt with one retry (non-scan artifacts, and the scan's ungrounded fallback). A cap
  // abort is not retried. On a grounded success `sources` come from the stream; an ungrounded body
  // always reports `sources: []`.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { usage, sources } = await streamAttempt(attemptKind, prefix);
      return await persistDone(usage, grounded ? sources : [], grounded);
    } catch {
      if (abortedByCap() || attempt === 1) break;
    }
  }
  return await persistFailed();
}

/**
 * Fan out all four artifact calls under one deadline; persist and stream each; return the outcome.
 * The wall-cap timer and the token breaker together guarantee termination even if a stream never
 * ends (no loop without a stop rule). Emits `run.status` once at start; the per-artifact SSE is
 * emitted inside `deliverOne`.
 */
export async function runDeliver(ctx: DeliverCtx): Promise<DeliverOutcome> {
  const { runId, idea, transcript, debateTokens, deps, sse, cfg, startedAt } = ctx;
  const { now } = deps;

  sse.send("run.status", { status: "running", phase: "deliver" });

  const controller = new AbortController();

  // Wall cap: abort with a `timeout` sentinel when the remaining budget elapses. A non-positive
  // remainder fires the abort on the next tick.
  const elapsedS = (now() - startedAt) / 1000;
  const remainingMs = Math.max(0, (cfg.RUN_WALL_CAP_S - elapsedS) * 1000);
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new DeliverAbort("timeout"));
  }, remainingMs);

  // Token budget: split the remaining allowance four ways (floor ≥ 0). As each artifact reports its
  // `done` usage, accumulate and trip the budget breaker if the run total exceeds the cap.
  const remainingTokens = cfg.RUN_TOKEN_CAP - (debateTokens.input + debateTokens.output);
  const maxOutputTokens = Math.max(0, Math.floor(remainingTokens / 4));

  const results = new Map<ArtifactType, OneResult>();
  let deliverIn = 0;
  let deliverOut = 0;

  const promises = ARTIFACT_TYPES.map((type) =>
    deliverOne({ type, idea, transcript, deps, sse, runId, maxOutputTokens, signal: controller.signal }).then((r) => {
      results.set(type, r);
      if (r.status === "done") {
        deliverIn += r.usage.input;
        deliverOut += r.usage.output;
        const runTotal = debateTokens.input + debateTokens.output + deliverIn + deliverOut;
        if (runTotal > cfg.RUN_TOKEN_CAP && !controller.signal.aborted) {
          controller.abort(new DeliverAbort("budget"));
        }
      }
      return r;
    }),
  );

  try {
    await Promise.allSettled(promises);
  } finally {
    clearTimeout(timer);
  }

  // Build the outcome from the settled results and the abort reason. `usage` sums only artifacts
  // that reported `done`; a streaming→failed artifact contributes 0.
  const artifacts = {} as Record<ArtifactType, "done" | "failed">;
  let usageIn = 0;
  let usageOut = 0;
  for (const type of ARTIFACT_TYPES) {
    const r = results.get(type);
    if (r?.status === "done") {
      artifacts[type] = "done";
      usageIn += r.usage.input;
      usageOut += r.usage.output;
    } else {
      artifacts[type] = "failed";
    }
  }

  // `grounded` in the outcome = whether the scan artifact ended grounded (false if it fell back or
  // failed — `deliverOne` already reports `grounded: false` in both of those cases).
  const grounded = results.get("scan")?.grounded === true;
  const usage: Usage = { input: usageIn, output: usageOut };

  if (ARTIFACT_TYPES.every((t) => artifacts[t] === "done")) {
    return { status: "complete", grounded, usage, artifacts };
  }

  // A cap that fired names the reason; otherwise one or more artifacts failed their retry without a
  // cap → model_error.
  const abortReason = controller.signal.reason;
  const reason: DeliverReason = abortReason instanceof DeliverAbort ? abortReason.reason : "model_error";
  return { status: "failed", reason, grounded, usage, artifacts };
}
