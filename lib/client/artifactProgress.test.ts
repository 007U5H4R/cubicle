import { describe, expect, it } from "vitest";
import { HEADINGS } from "@/lib/prompts/headings";
import { artifactProgress } from "./artifactProgress";

// TKT-14 Dispatch A — TC-056 (partial): artifactProgress heading-detection coverage.

describe("artifactProgress", () => {
  it("empty md -> done 0", () => {
    expect(artifactProgress("prd", "")).toEqual({ done: 0, total: 6, reached: [false, false, false, false, false, false] });
  });

  it("whitespace-only md -> done 0", () => {
    expect(artifactProgress("prd", "   \n\n  ")).toMatchObject({ done: 0, total: 6 });
  });

  it("one heading present -> done 1", () => {
    const md = "## Problem\nSome prose about the problem.\n";
    const result = artifactProgress("prd", md);
    expect(result.done).toBe(1);
    expect(result.reached[0]).toBe(true);
    expect(result.reached.slice(1).every((r) => r === false)).toBe(true);
  });

  it("all headings in order -> done = total", () => {
    const md = HEADINGS.prd.map((h) => `## ${h}\nprose\n`).join("\n");
    const result = artifactProgress("prd", md);
    expect(result.done).toBe(6);
    expect(result.total).toBe(6);
    expect(result.reached).toEqual([true, true, true, true, true, true]);
  });

  it("lenient: numbered prefix, case, and extra whitespace all count", () => {
    expect(artifactProgress("prd", "## 1. Problem\n").reached[0]).toBe(true);
    expect(artifactProgress("prd", "## PROBLEM\n").reached[0]).toBe(true);
    expect(artifactProgress("prd", "##   problem  \n").reached[0]).toBe(true);
    expect(artifactProgress("prd", "## Problem statement\n").reached[0]).toBe(true);
  });

  it("# and ### headings do not count", () => {
    expect(artifactProgress("prd", "# Problem\n").reached[0]).toBe(false);
    expect(artifactProgress("prd", "### Problem\n").reached[0]).toBe(false);
  });

  it("scan headings (3)", () => {
    const md = "## Three competitors\n...\n## What this means for positioning\n...\n";
    const result = artifactProgress("scan", md);
    expect(result.total).toBe(3);
    expect(result.done).toBe(2);
    expect(result.reached).toEqual([true, true, false]);
  });

  it("copy headings (5)", () => {
    const md = "## Headline\nHi\n## Call to action\nBuy now\n";
    const result = artifactProgress("copy", md);
    expect(result.total).toBe(5);
    expect(result.done).toBe(2);
    expect(result.reached).toEqual([true, false, false, true, false]);
  });

  it("plan headings (5)", () => {
    const md = HEADINGS.plan.map((h) => `## ${h}\n`).join("\n");
    const result = artifactProgress("plan", md);
    expect(result.total).toBe(5);
    expect(result.done).toBe(5);
  });

  it("partial mid-stream md: some headings done, trailing prose of an in-progress section not a heading match", () => {
    const md = [
      "## Problem",
      "The problem is that users can't easily...",
      "",
      "## Who it is for",
      "Early-stage founders who need to validate ideas fast, and this section is still",
      "streaming more prose that has not reached the next heading yet",
    ].join("\n");
    const result = artifactProgress("prd", md);
    expect(result.done).toBe(2);
    expect(result.reached).toEqual([true, true, false, false, false, false]);
  });
});
