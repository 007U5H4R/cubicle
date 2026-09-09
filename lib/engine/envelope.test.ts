import { describe, expect, it } from "vitest";
import { agentOutputSchema, wordCount } from "./envelope";
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
const base = { to: "pm" as const, act: "propose" as const, subject: "s", body: "b" };
describe("wordCount", () => {
  it("counts words across whitespace runs and newlines", () => { expect(wordCount("a  b\nc")).toBe(3); });
});
describe("agentOutputSchema", () => {
  it("accepts a 12-word subject", () => { expect(agentOutputSchema.safeParse({ ...base, subject: words(12) }).success).toBe(true); });
  it("rejects a 13-word subject", () => { expect(agentOutputSchema.safeParse({ ...base, subject: words(13) }).success).toBe(false); });
  it("rejects an 81-word body", () => { expect(agentOutputSchema.safeParse({ ...base, body: words(81) }).success).toBe(false); });
  it("accepts an 80-word body", () => { expect(agentOutputSchema.safeParse({ ...base, body: words(80) }).success).toBe(true); });
  it("rejects an act outside the enum", () => { expect(agentOutputSchema.safeParse({ ...base, act: "nope" }).success).toBe(false); });
  it("accepts to: team", () => { expect(agentOutputSchema.safeParse({ ...base, to: "team" }).success).toBe(true); });
});
