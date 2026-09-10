import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOrchestratorUserTurn, ORCHESTRATOR_PREFIX } from "./orchestrator";

// §8.1 orchestrator prompt tests.

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Verbatim from Solution-PRD.md §8.1, `>` quote markers dropped, paragraphs joined by a blank line.
const EXPECTED_PREFIX = [
  "You run a four-person product team's ten-minute stand-up, compressed into six messages. The team: **pm** (frames problem, user, value), **researcher** (knows the market, must object at least once with a reason), **designer** (turns the framing into a promise a stranger would click), **developer** (cuts scope to the smallest buildable slice).",
  "Each turn, read the ROSTER and the TRANSCRIPT and choose who speaks next and a one-line brief telling them what to respond to. Rules: pm speaks first. researcher speaks by turn 3. Nobody speaks twice until everyone has spoken once. An objection or question is answered by its addressee on the next turn. When every role has spoken and at least one objection has been answered, return done.",
  'Output JSON only: {"next": "pm|researcher|designer|developer|done", "brief": "one line"}.',
].join("\n\n");

describe("ORCHESTRATOR_PREFIX", () => {
  it("§8.1 matches the spec text verbatim", () => {
    expect(ORCHESTRATOR_PREFIX).toBe(EXPECTED_PREFIX);
  });

  it("is free of dates/counters and does not embed actual transcript data (mentioning the word TRANSCRIPT as an instruction is fine)", () => {
    expect(ORCHESTRATOR_PREFIX).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(ORCHESTRATOR_PREFIX).not.toMatch(/pm: /);
  });

  it("is byte-stable (locked hash — a change here means the prompt text changed)", () => {
    expect(sha256(ORCHESTRATOR_PREFIX)).toBe(sha256(EXPECTED_PREFIX));
  });
});

describe("buildOrchestratorUserTurn", () => {
  it("carries the roster block and transcript text in the user turn", () => {
    const turn = buildOrchestratorUserTurn("ROSTER\npm turns:0", "pm: hello");
    expect(turn).toBe("ROSTER\npm turns:0\n\nTRANSCRIPT\npm: hello");
  });
});
