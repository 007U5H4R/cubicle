import { z } from "zod";
import { ROLES, type Envelope, type Role } from "./envelope";

// §5.4 + §8.1 decision schema, fixed fallback order, and a gateway-agnostic decideNext.
// Vendor isolation: this file must not import "@google/genai" — it depends only on the
// minimal Gateway interface below, injected by the caller (06.4 adapts the real Gateway to it).

export const orchestratorDecisionSchema = z.object({
  next: z.enum([...ROLES, "done"]),
  brief: z.string(),
});
export type OrchestratorDecision = z.infer<typeof orchestratorDecisionSchema>;
export const orchestratorDecisionJsonSchema = {
  type: "object",
  properties: {
    next: { type: "string", enum: [...ROLES, "done"] },
    brief: { type: "string" },
  },
  required: ["next", "brief"],
};

/** §5.4 fallback order, used once the orchestrator model has failed twice (counted by the
 * caller/loop in 06.4, not here). */
export const FIXED_ORDER: Role[] = ["pm", "researcher", "pm", "designer", "developer"];

/** Pure fallback speaker for the current turn. `turnIndex` is the 0-based index of the debate
 * message about to be produced (i.e. the count of role messages so far — office ignored).
 * Past the end of FIXED_ORDER the index clamps to the last entry: the debate is already at/near
 * DEBATE_MSG_CAP by then (§5.1), so the loop is expected to stop rather than keep calling this. */
export function nextFixed(messages: Envelope[]): Role {
  const turnIndex = messages.filter((m) => (ROLES as readonly string[]).includes(m.from_role)).length;
  const clamped = Math.min(turnIndex, FIXED_ORDER.length - 1);
  return FIXED_ORDER[clamped];
}

/** Minimal gateway interface `decideNext` depends on — deliberately not the real Gateway type,
 * so this file stays testable with a stub and never imports the SDK. */
export interface OrchestratorGateway {
  chatJson(args: { systemPrefix: string; userTurn: string; jsonSchema: unknown }): Promise<unknown>;
}

export type DecideNextResult =
  | { ok: true; decision: OrchestratorDecision }
  | { ok: false; error: string };

/** Calls the injected gateway, then parses+validates the response with the zod schema.
 * Never throws and never silently swallows a failure: both a rejected/throwing gateway call and
 * an invalid JSON payload come back as `{ ok: false, error }` so the caller (06.4's loop) can
 * count the failure and, after two, switch to `nextFixed`. */
export async function decideNext(
  gateway: OrchestratorGateway,
  args: { systemPrefix: string; userTurn: string },
): Promise<DecideNextResult> {
  let raw: unknown;
  try {
    raw = await gateway.chatJson({
      systemPrefix: args.systemPrefix,
      userTurn: args.userTurn,
      jsonSchema: orchestratorDecisionJsonSchema,
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "gateway call failed" };
  }

  const parsed = orchestratorDecisionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message };
  }
  return { ok: true, decision: parsed.data };
}
