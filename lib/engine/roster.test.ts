import { describe, expect, it } from "vitest";
import { buildRoster, formatRoster } from "./roster";
import type { Envelope } from "./envelope";

// §5.3 roster injection tests. TC-025.

const msg = (over: Partial<Envelope>): Envelope => ({
  id: "id", run_id: "r", seq: 0, from_role: "pm", to_role: "team", to: "team",
  act: "propose", subject: "s", body: "b", reply_to: null, hops: 0, brief: null,
  created_at: "2026-01-01T00:00:00Z", ...over,
});

describe("buildRoster", () => {
  it("§5.3 empty debate -> all zero turns, null last_act/stance, fixed role order", () => {
    const lines = buildRoster([]);
    expect(lines.map((l) => l.role)).toEqual(["pm", "researcher", "designer", "developer"]);
    for (const l of lines) {
      expect(l.turns).toBe(0);
      expect(l.last_act).toBeNull();
      expect(l.stance).toBeNull();
    }
  });

  it("§5.3 after 3 messages, turns/last_act/stance reflect each role's most recent message", () => {
    const messages: Envelope[] = [
      msg({ id: "1", seq: 1, from_role: "pm", act: "propose", subject: "households lose track of subscriptions; v1 = tracker + reminders" }),
      msg({ id: "2", seq: 2, from_role: "researcher", act: "objection", subject: "three incumbents already do reminders; differentiation unclear" }),
      msg({ id: "3", seq: 3, from_role: "office", act: "propose", subject: "steer message" }),
    ];
    const lines = buildRoster(messages);
    expect(lines).toEqual([
      { role: "pm", turns: 1, last_act: "propose", stance: "households lose track of subscriptions; v1 = tracker + reminders" },
      { role: "researcher", turns: 1, last_act: "objection", stance: "three incumbents already do reminders; differentiation unclear" },
      { role: "designer", turns: 0, last_act: null, stance: null },
      { role: "developer", turns: 0, last_act: null, stance: null },
    ]);
  });

  it("§5.3 ignores office messages when counting turns", () => {
    const messages: Envelope[] = [msg({ id: "1", from_role: "office", act: "propose" })];
    const lines = buildRoster(messages);
    expect(lines.every((l) => l.turns === 0)).toBe(true);
  });

  it("§5.3 turns counts all of a role's messages, last_act/stance reflect the most recent", () => {
    const messages: Envelope[] = [
      msg({ id: "1", seq: 1, from_role: "pm", act: "propose", subject: "first" }),
      msg({ id: "2", seq: 2, from_role: "pm", act: "agree", subject: "second" }),
    ];
    const lines = buildRoster(messages);
    const pm = lines.find((l) => l.role === "pm")!;
    expect(pm.turns).toBe(2);
    expect(pm.last_act).toBe("agree");
    expect(pm.stance).toBe("second");
  });
});

describe("formatRoster", () => {
  it("§5.3 exact byte-stable format from the spec sample", () => {
    const lines = [
      { role: "pm" as const, turns: 1, last_act: "propose" as const, stance: "households lose track of subscriptions; v1 = tracker + reminders" },
      { role: "researcher" as const, turns: 1, last_act: "objection" as const, stance: "three incumbents already do reminders; differentiation unclear" },
      { role: "designer" as const, turns: 0, last_act: null, stance: null },
      { role: "developer" as const, turns: 0, last_act: null, stance: null },
    ];
    const expected = [
      "ROSTER (this supersedes any roster earlier in this conversation)",
      'pm         turns:1  last_act:propose   stance:"households lose track of subscriptions; v1 = tracker + reminders"',
      'researcher turns:1  last_act:objection stance:"three incumbents already do reminders; differentiation unclear"',
      "designer   turns:0  last_act:-         stance:-",
      "developer  turns:0  last_act:-         stance:-",
    ].join("\n");
    expect(formatRoster(lines)).toBe(expected);
  });

  it("§5.3 empty debate -> all zero/-", () => {
    const lines = buildRoster([]);
    const text = formatRoster(lines);
    expect(text).toBe(
      [
        "ROSTER (this supersedes any roster earlier in this conversation)",
        "pm         turns:0  last_act:-         stance:-",
        "researcher turns:0  last_act:-         stance:-",
        "designer   turns:0  last_act:-         stance:-",
        "developer  turns:0  last_act:-         stance:-",
      ].join("\n"),
    );
  });
});
