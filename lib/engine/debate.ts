import "server-only";
import { track } from "@/lib/events";
import type { Usage } from "@/lib/gateway";
import { ORCHESTRATOR_PREFIX, buildOrchestratorUserTurn } from "@/lib/prompts/orchestrator";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import { agentOutputJsonSchema, agentOutputSchema, type AgentOutput, type Envelope, type Role } from "./envelope";
import {
  decideNext,
  nextFixed,
  orchestratorDecisionJsonSchema,
  orchestratorDecisionSchema,
  type OrchestratorGateway,
} from "./orchestrate";
import { buildRoster, formatRoster } from "./roster";
import { enforceRules } from "./rules";
import { evaluateStop, type StopReason } from "./stop";
import type { RunDeps, RunSse } from "./run";

// TSK-06.4 — the §5 debate loop. Orchestrates roster (§5.3), speaker rules (§5.2), stop guards
// (§5.1), the office steer, orchestrator→fixed fallback (§5.4), and agent-call retry/skip, wiring
// the task-6A building blocks together. Fully injectable (deps + clock + cfg) so it runs offline
// against in-memory doubles. Vendor-isolated: it never imports a model SDK — only the Gateway
// passed in via deps.

export type DebateCfg = { DEBATE_MSG_CAP: number; DEBATE_WALL_CAP_S: number; RUN_TOKEN_CAP: number };

export interface DebateCtx {
  runId: string;
  idea: string;
  anonSessionId: string | null;
  deps: RunDeps;
  sse: RunSse;
  cfg: DebateCfg;
  startedAt: number;
}

export interface DebateOutcome {
  messages: Envelope[];
  objections: number;
  stop_reason: StopReason;
  usage: Usage;
}

/** §5 soft nudge: at 35s the "office" injects a wrap-up message (costs no model call). */
const STEER_AT_S = 35;
const STEER_SUBJECT = "Time check";
const STEER_BODY = "Wrap it up, we deliver in ten seconds.";

/** Brief handed to a speaker when the orchestrator model has failed twice and the fixed order
 * (§5.4) is driving. Volatile only — never baked into the byte-stable ROLE_PREFIX. */
const GENERIC_BRIEF = "Respond to the latest point and move the team toward a decision.";

/** Safety breaker (global rule: no loop without a stop rule). A skipped turn means the agent call
 * threw twice; if the model is unavailable for this many turns in a row, no message can ever be
 * persisted (so no message/token stop guard can fire) — fail the run instead of spinning. */
const MAX_STALLED_TURNS = 3;

/** Compact transcript for the prompts: one `from_role: body` line per message so far. */
function transcriptText(messages: Envelope[]): string {
  if (messages.length === 0) return "(none yet)";
  return messages.map((m) => `${m.from_role}: ${m.body}`).join("\n");
}

/** Per-call agent user turn — volatile context only (idea, transcript, brief). */
function agentUserTurn(idea: string, transcript: string, brief: string): string {
  return `IDEA: ${idea}\nTRANSCRIPT:\n${transcript}\nBRIEF: ${brief}`;
}

/**
 * Runs the debate phase to a stop reason, persisting each message (stripping the wire-only `to`
 * field), streaming SSE, and emitting `debate_completed`. Returns the transcript, objection count,
 * stop reason, and accumulated token usage (agent + orchestrator) for the caller's run row.
 */
export async function runDebate(ctx: DebateCtx): Promise<DebateOutcome> {
  const { runId, idea, anonSessionId, deps, sse, cfg, startedAt } = ctx;
  const { db, gateway, sink, now } = deps;

  const messages: Envelope[] = [];
  let seq = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let orchestratorFailures = 0;
  let steered = false;
  let stalledTurns = 0;
  let stopReason: StopReason;

  // Adapt the real Gateway to decideNext's minimal OrchestratorGateway so its tested failure-signal
  // path (throw / invalid → { ok: false }) drives the failure counter. Orchestrator token usage is
  // captured here (decideNext discards it) so the run's token accounting stays honest.
  const orchestratorAdapter: OrchestratorGateway = {
    async chatJson({ systemPrefix, userTurn }) {
      const { data, usage } = await gateway.chat(
        "orchestrator",
        systemPrefix,
        userTurn,
        orchestratorDecisionSchema,
        orchestratorDecisionJsonSchema,
      );
      tokensIn += usage.input;
      tokensOut += usage.output;
      return data;
    },
  };

  for (;;) {
    const elapsedS = (now() - startedAt) / 1000;
    const tokens = tokensIn + tokensOut;

    const stop = evaluateStop({ messages, elapsedS, tokens, cfg });
    if (stop) {
      stopReason = stop;
      break;
    }

    // Office steer at 35s — persisted + streamed, counts toward DEBATE_MSG_CAP, no model call.
    if (elapsedS >= STEER_AT_S && !steered) {
      const steer: Envelope = {
        id: crypto.randomUUID(),
        run_id: runId,
        seq: ++seq,
        from_role: "office",
        to: "team",
        to_role: "team",
        act: "agree", // obligates no reply (rule 4 never fires: from office, to the whole team)
        subject: STEER_SUBJECT,
        body: STEER_BODY,
        reply_to: null,
        hops: 0,
        brief: null,
        created_at: new Date(now()).toISOString(),
      };
      // The office message is not an AgentOutput; Envelope still types `to`, so strip it like any
      // other row (the messages table has no `to` column → PGRST204).
      const { to: _officeTo, ...steerRow } = steer;
      const { error } = await db.from("messages").insert(steerRow);
      if (error) throw new Error(error.message);
      sse.send("steer", steerRow);
      messages.push(steer);
      steered = true;
      continue;
    }

    const roster = formatRoster(buildRoster(messages));
    const transcript = transcriptText(messages);

    // §5.4 orchestrator with fixed-order fallback after two failures (in a turn and cumulatively).
    let pick: Role | "done" | undefined;
    let brief = "";
    if (orchestratorFailures < 2) {
      const userTurn = buildOrchestratorUserTurn(roster, transcript);
      while (orchestratorFailures < 2) {
        const r = await decideNext(orchestratorAdapter, { systemPrefix: ORCHESTRATOR_PREFIX, userTurn });
        if (r.ok) {
          pick = r.decision.next;
          brief = r.decision.brief;
          break;
        }
        orchestratorFailures++; // retry once this turn; on the second failure, fall through to fixed
      }
    }
    if (pick === undefined) {
      pick = nextFixed(messages);
      brief = GENERIC_BRIEF;
    }
    if (pick === "done") {
      stopReason = "done";
      break;
    }

    // §5.2 re-check the pick and rewrite the brief (`[override: rule N] …`) if it broke a rule.
    const { speaker, brief: finalBrief } = enforceRules({ pick, brief, messages });

    sse.send("run.status", { status: "running", phase: "debate", thinking: speaker });

    // Agent call: one retry, then skip the turn (persist nothing) and continue.
    let output: AgentOutput | undefined;
    let usage: Usage | undefined;
    const agentUser = agentUserTurn(idea, transcript, finalBrief);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await gateway.chat("agent", ROLE_PREFIX[speaker], agentUser, agentOutputSchema, agentOutputJsonSchema);
        output = res.data;
        usage = res.usage;
        break;
      } catch {
        // swallow and retry; a second failure leaves output undefined → skip below
      }
    }
    if (output === undefined || usage === undefined) {
      stalledTurns++;
      if (stalledTurns >= MAX_STALLED_TURNS) {
        throw new Error(`debate stalled: agent call failed on ${stalledTurns} consecutive turns`);
      }
      continue;
    }
    stalledTurns = 0;

    // §5.1 reply chain: only when the immediately-previous message is a question/objection aimed
    // at this speaker (rule 4 territory) does this message continue that chain.
    const prev = messages[messages.length - 1];
    const isReply = !!prev && (prev.act === "question" || prev.act === "objection") && prev.to_role === speaker;
    const envelope: Envelope = {
      id: crypto.randomUUID(),
      run_id: runId,
      seq: ++seq,
      from_role: speaker,
      to: output.to,
      to_role: output.to,
      act: output.act,
      subject: output.subject,
      body: output.body,
      reply_to: isReply ? prev.id : null,
      hops: isReply ? prev.hops + 1 : 0,
      brief: finalBrief,
      created_at: new Date(now()).toISOString(),
    };
    const { to: _to, ...messageRow } = envelope;
    const { error } = await db.from("messages").insert(messageRow);
    if (error) throw new Error(error.message);
    sse.send("message", envelope);
    tokensIn += usage.input;
    tokensOut += usage.output;
    messages.push(envelope);
  }

  const objections = messages.filter((m) => m.act === "objection").length;
  await track(sink, "debate_completed", { messages: messages.length, objections, stop_reason: stopReason }, { anonSessionId, runId });
  return { messages, objections, stop_reason: stopReason, usage: { input: tokensIn, output: tokensOut } };
}
