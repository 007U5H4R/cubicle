import type { Envelope } from "@/lib/engine/envelope";
import { ARTIFACT_ROLE, HEADINGS, type ArtifactType } from "./headings";
import { ROLE_PREFIX } from "./roles";

/**
 * One `from_role: body` line per message, joined by "\n", in the given order
 * (caller passes messages already in `seq` order). Mirrors the private
 * `transcriptText` renderer in `lib/engine/debate.ts` for consistency; not
 * shared directly because that one is private to the debate loop and returns
 * "(none yet)" for an empty transcript instead of an empty string. Unifying
 * the two renderers is deferred to TKT-24.
 */
function renderTranscript(transcript: Envelope[]): string {
  return transcript.map((m) => `${m.from_role}: ${m.body}`).join("\n");
}

/** §8.6: TOOLS clause — Researcher gets Google Search, everyone else gets none. */
function toolsClause(type: ArtifactType): string {
  return type === "scan" ? "use Google Search and cite a source URL for every competitor." : "none.";
}

/**
 * RULING (controller) — the §10 table spec stripped from HEADINGS.scan is
 * re-emitted here, appended to the OUTPUT line for `scan` only.
 */
function scanTableClause(type: ArtifactType): string {
  return type === "scan"
    ? ' Under "Three competitors", give a markdown table with columns: name, what it does, the gap, source link.'
    : "";
}

/**
 * Assembles the per-artifact model call (§8.6): a byte-stable `system`
 * (the existing role prefix, reused verbatim) and a `user` turn carrying
 * every volatile input (idea, transcript, output headings, tools, boundaries).
 */
export function buildDispatch(
  type: ArtifactType,
  idea: string,
  transcript: Envelope[]
): { system: string; user: string } {
  const role = ARTIFACT_ROLE[type];
  const system = ROLE_PREFIX[role];

  const user = [
    `IDEA: ${idea}`,
    `TRANSCRIPT:`,
    renderTranscript(transcript),
    `OBJECTIVE: write your artifact for this idea, reflecting what the team settled and naming what it did not.`,
    `OUTPUT: markdown with exactly these headings, in this order, ≤ 350 words total: ${HEADINGS[type].join(" · ")}.${scanTableClause(type)}`,
    `TOOLS: ${toolsClause(type)}`,
    `BOUNDARIES: no features beyond the transcript; no invented numbers; where the team disagreed and did not resolve it, say so under the relevant heading.`,
  ].join("\n");

  return { system, user };
}
