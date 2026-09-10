import { describe, expect, it } from "vitest";
import { enforceRules } from "./rules";
import type { Envelope, Role } from "./envelope";

// §5.2 orchestrator rules tests. TC-024.

const msg = (over: Partial<Envelope>): Envelope => ({
  id: "id", run_id: "r", seq: 0, from_role: "pm", to_role: "team", to: "team",
  act: "propose", subject: "s", body: "b", reply_to: null, hops: 0, brief: null,
  created_at: "2026-01-01T00:00:00Z", ...over,
});

const roleMsg = (role: Role, over: Partial<Envelope> = {}) => msg({ from_role: role, ...over });

describe("enforceRules", () => {
  it("§5.2 rule 1: turn 0 (empty debate) forces pm regardless of pick", () => {
    const result = enforceRules({ pick: "designer", brief: "go", messages: [] });
    expect(result).toEqual({ speaker: "pm", brief: "[override: rule 1] go", overrideRule: 1 });
  });

  it("§5.2 rule 1: does not fire once messages exist", () => {
    const messages = [roleMsg("pm")];
    const result = enforceRules({ pick: "researcher", brief: "go", messages });
    expect(result).toEqual({ speaker: "researcher", brief: "go" });
  });

  it("§5.2 rule 2: turn index 2 (3rd turn) forces researcher if researcher has 0 turns", () => {
    const messages = [roleMsg("pm"), roleMsg("designer")];
    const result = enforceRules({ pick: "developer", brief: "go", messages });
    expect(result).toEqual({ speaker: "researcher", brief: "[override: rule 2] go", overrideRule: 2 });
  });

  it("§5.2 rule 2: does not fire if researcher already has turns by turn index 2", () => {
    const messages = [roleMsg("pm"), roleMsg("researcher")];
    const result = enforceRules({ pick: "designer", brief: "go", messages });
    expect(result).toEqual({ speaker: "designer", brief: "go" });
  });

  it("§5.2 rule 2: does not fire if pick is already researcher", () => {
    const messages = [roleMsg("pm"), roleMsg("designer")];
    const result = enforceRules({ pick: "researcher", brief: "go", messages });
    expect(result).toEqual({ speaker: "researcher", brief: "go" });
  });

  it("§5.2 rule 3: nobody speaks twice until everyone has spoken once - overrides to first role at minimum turns", () => {
    // pm has 3 turns, others have 0. Pick (pm) already exceeds the min (0) while others are still
    // at min. Uses 3 pm turns (turn index 3) so rule 2's turn-index-2 window is not also hit.
    const messages = [roleMsg("pm"), roleMsg("pm"), roleMsg("pm")];
    const result = enforceRules({ pick: "pm", brief: "go", messages });
    // researcher is the first role in pm,researcher,designer,developer order with the min turn count (0).
    expect(result).toEqual({ speaker: "researcher", brief: "[override: rule 3] go", overrideRule: 3 });
  });

  it("§5.2 rule 3: does not fire when the pick is already at the minimum turn count", () => {
    const messages = [roleMsg("pm"), roleMsg("researcher")];
    const result = enforceRules({ pick: "designer", brief: "go", messages });
    expect(result).toEqual({ speaker: "designer", brief: "go" });
  });

  it("§5.2 rule 4: an unanswered question/objection to a specific role forces that role next (all roles at equal turn count, so rule 3 does not also fire)", () => {
    const messages = [
      roleMsg("pm"),
      roleMsg("researcher"),
      roleMsg("designer"),
      roleMsg("developer", { act: "objection", to_role: "pm" }),
    ];
    const result = enforceRules({ pick: "researcher", brief: "go", messages });
    expect(result).toEqual({ speaker: "pm", brief: "[override: rule 4] go", overrideRule: 4 });
  });

  it("§5.2 rule 4: to_role team never triggers the override", () => {
    const messages = [
      roleMsg("pm"),
      roleMsg("researcher"),
      roleMsg("designer"),
      roleMsg("developer", { act: "objection", to_role: "team" }),
    ];
    const result = enforceRules({ pick: "researcher", brief: "go", messages });
    expect(result).toEqual({ speaker: "researcher", brief: "go" });
  });

  it("§5.2 rule 4: does not fire when last message act is agree/propose/done", () => {
    const messages = [
      roleMsg("pm"),
      roleMsg("researcher"),
      roleMsg("designer"),
      roleMsg("developer", { act: "agree", to_role: "pm" }),
    ];
    const result = enforceRules({ pick: "researcher", brief: "go", messages });
    expect(result).toEqual({ speaker: "researcher", brief: "go" });
  });

  it("§5.2 first matching rule wins when several could apply (rule 1 beats later rules)", () => {
    // Empty debate: rule 1 always wins regardless of any rule 4-shaped pick.
    const result = enforceRules({ pick: "researcher", brief: "go", messages: [] });
    expect(result.overrideRule).toBe(1);
  });

  it("§5.2 clean pass: legal pick with no rule violated returns brief unchanged, no overrideRule", () => {
    const messages = [
      roleMsg("pm"),
      roleMsg("researcher"),
      roleMsg("designer"),
      roleMsg("developer"),
    ];
    const result = enforceRules({ pick: "pm", brief: "wrap up", messages });
    expect(result).toEqual({ speaker: "pm", brief: "wrap up" });
  });
});
