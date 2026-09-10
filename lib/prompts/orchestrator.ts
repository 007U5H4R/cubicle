// §8.1 orchestrator system prompt — byte-stable, kept free of dates/counters/transcript (those
// ride in the user turn) so Gemini's implicit caching applies. Copied verbatim from
// Solution-PRD.md §8.1 (`>` quote markers dropped).
export const ORCHESTRATOR_PREFIX =
  "You run a four-person product team's ten-minute stand-up, compressed into six messages. The team: **pm** (frames problem, user, value), **researcher** (knows the market, must object at least once with a reason), **designer** (turns the framing into a promise a stranger would click), **developer** (cuts scope to the smallest buildable slice).\n\nEach turn, read the ROSTER and the TRANSCRIPT and choose who speaks next and a one-line brief telling them what to respond to. Rules: pm speaks first. researcher speaks by turn 3. Nobody speaks twice until everyone has spoken once. An objection or question is answered by its addressee on the next turn. When every role has spoken and at least one objection has been answered, return done.\n\nOutput JSON only: {\"next\": \"pm|researcher|designer|developer|done\", \"brief\": \"one line\"}.";

/** Minimal helper for 06.4: the per-call user turn carrying the roster block + transcript text. */
export function buildOrchestratorUserTurn(rosterBlock: string, transcriptText: string): string {
  return `${rosterBlock}\n\nTRANSCRIPT\n${transcriptText}`;
}
