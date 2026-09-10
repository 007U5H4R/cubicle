import { describe, expect, it } from "vitest";
import type { Envelope } from "@/lib/engine/envelope";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, HEADINGS, type ArtifactType } from "./headings";
import { ROLE_PREFIX } from "./roles";
import { buildDispatch } from "./dispatch";

// §8.6 dispatch builder tests. Byte-locks the four-part user-turn template.

function env(seq: number, from_role: Envelope["from_role"], body: string): Envelope {
  return {
    id: `e${seq}`,
    run_id: "r1",
    seq,
    from_role,
    to_role: "team",
    reply_to: null,
    hops: 0,
    brief: null,
    created_at: "2026-01-01T00:00:00.000Z",
    to: "team",
    act: "propose",
    subject: "s",
    body,
  };
}

describe("buildDispatch: system", () => {
  it.each(ARTIFACT_TYPES)("%s: system is ROLE_PREFIX[ARTIFACT_ROLE[type]] verbatim", (type) => {
    const { system } = buildDispatch(type, "idea", []);
    expect(system).toBe(ROLE_PREFIX[ARTIFACT_ROLE[type]]);
  });
});

describe("buildDispatch: user turn contents", () => {
  it.each(ARTIFACT_TYPES)("%s: contains IDEA, transcript lines in order, headings in order, OBJECTIVE, BOUNDARIES", (type) => {
    const transcript = [env(1, "pm", "we should ship X"), env(2, "researcher", "incumbents exist")];
    const { user } = buildDispatch(type, "a solo-founder tool", transcript);

    expect(user).toContain("IDEA: a solo-founder tool");

    const rendered = "pm: we should ship X\nresearcher: incumbents exist";
    expect(user).toContain(rendered);

    const outputLine = user.split("\n").find((l) => l.startsWith("OUTPUT:"));
    expect(outputLine).toBeDefined();
    const headings = HEADINGS[type as ArtifactType];
    let lastIndex = -1;
    for (const h of headings) {
      const idx = outputLine!.indexOf(h);
      expect(idx).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }

    expect(user).toContain(
      "OBJECTIVE: write your artifact for this idea, reflecting what the team settled and naming what it did not."
    );
    expect(user).toContain(
      "BOUNDARIES: no features beyond the transcript; no invented numbers; where the team disagreed and did not resolve it, say so under the relevant heading."
    );
  });
});

describe("buildDispatch: TOOLS clause", () => {
  it("scan: uses the Google Search tools clause and the table-columns clause", () => {
    const { user } = buildDispatch("scan", "idea", []);
    expect(user).toContain("TOOLS: use Google Search and cite a source URL for every competitor.");
    expect(user).toContain(
      'Under "Three competitors", give a markdown table with columns: name, what it does, the gap, source link.'
    );
  });

  it.each(["prd", "copy", "plan"] as const)("%s: TOOLS: none. and no table clause", (type) => {
    const { user } = buildDispatch(type, "idea", []);
    expect(user).toContain("TOOLS: none.");
    expect(user).not.toContain("markdown table with columns");
  });
});

describe("buildDispatch: transcript rendering", () => {
  it("renders one `from_role: body` line per message, joined by \\n, in seq order", () => {
    const transcript = [
      env(2, "researcher", "second"),
      env(1, "pm", "first"),
      env(3, "designer", "third"),
    ].sort((a, b) => a.seq - b.seq);
    const { user } = buildDispatch("prd", "idea", transcript);
    expect(user).toContain("pm: first\nresearcher: second\ndesigner: third");
  });

  it("empty transcript renders an empty block without crashing", () => {
    expect(() => buildDispatch("prd", "idea", [])).not.toThrow();
    const { user } = buildDispatch("prd", "idea", []);
    expect(user).toContain("TRANSCRIPT:\n\nOBJECTIVE:");
  });
});

describe("buildDispatch: full user-turn byte-lock (prd)", () => {
  it("matches the exact §8.6 template for a known idea/transcript", () => {
    const transcript = [env(1, "pm", "framing"), env(2, "researcher", "objection")];
    const { user } = buildDispatch("prd", "a solo-founder tool", transcript);
    expect(user).toBe(
      [
        "IDEA: a solo-founder tool",
        "TRANSCRIPT:",
        "pm: framing\nresearcher: objection",
        "OBJECTIVE: write your artifact for this idea, reflecting what the team settled and naming what it did not.",
        "OUTPUT: markdown with exactly these headings, in this order, ≤ 350 words total: Problem · Who it is for · Proposed solution · v1 scope: in / out · One success metric · The open question we argued about.",
        "TOOLS: none.",
        "BOUNDARIES: no features beyond the transcript; no invented numbers; where the team disagreed and did not resolve it, say so under the relevant heading.",
      ].join("\n")
    );
  });
});
