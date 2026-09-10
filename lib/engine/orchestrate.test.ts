import { describe, expect, it } from "vitest";
import {
  decideNext,
  FIXED_ORDER,
  nextFixed,
  orchestratorDecisionSchema,
  type OrchestratorGateway,
} from "./orchestrate";
import type { Envelope } from "./envelope";

// §5.4 + §8.1 orchestrator decision schema, fallback order, and decideNext tests. TC-028 (partial,
// offline): valid parse, failure signal, FIXED_ORDER sequence.

const msg = (over: Partial<Envelope>): Envelope => ({
  id: "id", run_id: "r", seq: 0, from_role: "pm", to_role: "team", to: "team",
  act: "propose", subject: "s", body: "b", reply_to: null, hops: 0, brief: null,
  created_at: "2026-01-01T00:00:00Z", ...over,
});

describe("orchestratorDecisionSchema", () => {
  it("accepts a valid decision", () => {
    expect(orchestratorDecisionSchema.safeParse({ next: "pm", brief: "go" }).success).toBe(true);
  });
  it("accepts next: done", () => {
    expect(orchestratorDecisionSchema.safeParse({ next: "done", brief: "wrap" }).success).toBe(true);
  });
  it("rejects a next outside the enum", () => {
    expect(orchestratorDecisionSchema.safeParse({ next: "office", brief: "go" }).success).toBe(false);
  });
  it("rejects a missing brief", () => {
    expect(orchestratorDecisionSchema.safeParse({ next: "pm" }).success).toBe(false);
  });
});

describe("FIXED_ORDER / nextFixed (§5.4 fallback order)", () => {
  it("TC-028: yields pm, researcher, pm, designer, developer across turns", () => {
    expect(FIXED_ORDER).toEqual(["pm", "researcher", "pm", "designer", "developer"]);
  });

  it("nextFixed reads the fallback speaker from the current debate-message count", () => {
    const rounds: Envelope[][] = [];
    let acc: Envelope[] = [];
    rounds.push([...acc]);
    for (let i = 0; i < 5; i++) {
      acc = [...acc, msg({ id: `${i}`, seq: i, from_role: "pm" })];
      rounds.push([...acc]);
    }
    const picks = rounds.slice(0, 5).map((messages) => nextFixed(messages));
    expect(picks).toEqual(["pm", "researcher", "pm", "designer", "developer"]);
  });

  it("clamps to the last entry past the end of FIXED_ORDER", () => {
    const messages = Array.from({ length: 10 }, (_, i) => msg({ id: `${i}`, seq: i, from_role: "pm" }));
    expect(nextFixed(messages)).toBe("developer");
  });

  it("ignores office messages when computing the turn index", () => {
    const messages = [msg({ id: "0", from_role: "office" })];
    expect(nextFixed(messages)).toBe("pm");
  });
});

describe("decideNext", () => {
  it("TC-028 happy path: a valid stub response parses to {next, brief}", async () => {
    const gateway: OrchestratorGateway = {
      chatJson: async () => ({ next: "researcher", brief: "respond to the objection" }),
    };
    const result = await decideNext(gateway, { systemPrefix: "p", userTurn: "u" });
    expect(result).toEqual({
      ok: true,
      decision: { next: "researcher", brief: "respond to the objection" },
    });
  });

  it("TC-028 failure signal: a throwing gateway call returns an explicit ok:false error", async () => {
    const gateway: OrchestratorGateway = {
      chatJson: async () => {
        throw new Error("network down");
      },
    };
    const result = await decideNext(gateway, { systemPrefix: "p", userTurn: "u" });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("network down");
  });

  it("TC-028 failure signal: invalid JSON payload returns an explicit ok:false error, not a throw or silent swallow", async () => {
    const gateway: OrchestratorGateway = {
      chatJson: async () => ({ next: "not-a-role", brief: "go" }),
    };
    const result = await decideNext(gateway, { systemPrefix: "p", userTurn: "u" });
    expect(result.ok).toBe(false);
  });
});
