import { describe, expect, it } from "vitest";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, HEADINGS, type ArtifactType } from "./headings";

// §10 byte-lock: heading phrases only (parentheticals are content guidance, stripped —
// the scan table-column detail is re-emitted by buildDispatch instead, see dispatch.ts).

describe("ARTIFACT_TYPES", () => {
  it("matches the migration's type check-constraint values, in order", () => {
    expect(ARTIFACT_TYPES).toEqual(["prd", "scan", "copy", "plan"]);
  });
});

describe("ARTIFACT_ROLE", () => {
  it("maps each artifact type to its owning role per §10", () => {
    expect(ARTIFACT_ROLE).toEqual({
      prd: "pm",
      scan: "researcher",
      copy: "designer",
      plan: "developer",
    });
  });
});

describe("HEADINGS", () => {
  it("prd: exact §10 headings, in order", () => {
    expect(HEADINGS.prd).toEqual([
      "Problem",
      "Who it is for",
      "Proposed solution",
      "v1 scope: in / out",
      "One success metric",
      "The open question we argued about",
    ]);
  });

  it("scan: exact §10 headings, in order (table parenthetical stripped)", () => {
    expect(HEADINGS.scan).toEqual([
      "Three competitors",
      "What this means for positioning",
      "Confidence note",
    ]);
  });

  it("copy: exact §10 headings, in order", () => {
    expect(HEADINGS.copy).toEqual([
      "Headline",
      "Subheadline",
      "Three benefits",
      "Call to action",
      "Two objections, answered",
    ]);
  });

  it("plan: exact §10 headings, in order", () => {
    expect(HEADINGS.plan).toEqual([
      "Smallest v1 slice",
      "Suggested stack",
      "Five steps with rough time",
      "What we cut and why",
      "Riskiest assumption to test first",
    ]);
  });

  it("every ArtifactType key is present in both HEADINGS and ARTIFACT_ROLE", () => {
    const types: ArtifactType[] = [...ARTIFACT_TYPES];
    for (const t of types) {
      expect(HEADINGS[t]).toBeDefined();
      expect(ARTIFACT_ROLE[t]).toBeDefined();
    }
  });
});
