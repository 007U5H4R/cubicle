import { createHash } from "node:crypto";
import type { Envelope } from "./envelope";

// §5.1 stop rule. Phase 1 ends at the first guard to fire, evaluated in this exact table
// order: done (detected by the loop, not here) -> cap_messages -> cap_time -> cap_tokens -> repeat.

export type StopReason = "done" | "cap_messages" | "cap_time" | "cap_tokens" | "repeat";

export interface StopInput {
  messages: Envelope[]; // all persisted debate messages, including the office steer
  elapsedS: number;
  tokens: number;
  cfg: { DEBATE_MSG_CAP: number; DEBATE_WALL_CAP_S: number; RUN_TOKEN_CAP: number };
}

const TOKEN_CAP_FRACTION = 0.7;

/** sha-256 hex of `${from_role}|${act}|${body}`, used to detect a repeated message. */
export function messageHash(m: Pick<Envelope, "from_role" | "act" | "body">): string {
  return createHash("sha256").update(`${m.from_role}|${m.act}|${m.body}`).digest("hex");
}

/** Evaluates the stop guards in spec table order (rows 2-5; row 1 "done" is set by the caller
 * and is not detected here). Returns the first reason to fire, or null. */
export function evaluateStop(input: StopInput): StopReason | null {
  const { messages, elapsedS, tokens, cfg } = input;

  if (messages.length >= cfg.DEBATE_MSG_CAP) return "cap_messages";
  if (elapsedS >= cfg.DEBATE_WALL_CAP_S) return "cap_time";
  if (tokens >= cfg.RUN_TOKEN_CAP * TOKEN_CAP_FRACTION) return "cap_tokens";

  if (messages.length >= 2) {
    const last = messages[messages.length - 1];
    const prev = messages[messages.length - 2];
    if (messageHash(last) === messageHash(prev)) return "repeat";
  }

  return null;
}

/**
 * §5.1 hop cap: a reply chain reaching hops=3 is closed but the debate continues — this is
 * NOT a stop reason. Placed here (rather than roster.ts) because it derives from the same
 * per-message `hops` counter the stop guards already reason about. Pure: returns the set of
 * message ids whose chain has reached the cap (their own hops >= 3), so the roster/loop can
 * mark those chains closed without accepting further replies onto them. TC-025 (depth-3 case).
 */
export function closedChains(messages: Envelope[]): Set<string> {
  const HOP_CAP = 3;
  const closed = new Set<string>();
  for (const m of messages) {
    if (m.hops >= HOP_CAP) closed.add(m.id);
  }
  return closed;
}
