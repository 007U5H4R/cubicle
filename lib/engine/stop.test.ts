import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { closedChains, evaluateStop, messageHash } from "./stop";
import type { Envelope } from "./envelope";

// §5.1 stop-rule tests. TC-023 (guards + null + table-order tie-break),
// TC-025 (hop cap / closed chains, repeat-hash equality).

const CFG = { DEBATE_MSG_CAP: 6, DEBATE_WALL_CAP_S: 45, RUN_TOKEN_CAP: 60000 };

const msg = (over: Partial<Envelope>): Envelope => ({
  id: "id", run_id: "r", seq: 0, from_role: "pm", to_role: "team", to: "team",
  act: "propose", subject: "s", body: "b", reply_to: null, hops: 0, brief: null,
  created_at: "2026-01-01T00:00:00Z", ...over,
});

describe("evaluateStop", () => {
  it("§5.1 row 2: cap_messages fires at message count >= DEBATE_MSG_CAP", () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg({ id: `${i}`, seq: i }));
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 0, cfg: CFG });
    expect(result).toBe("cap_messages");
  });

  it("§5.1 row 3: cap_time fires at elapsedS >= DEBATE_WALL_CAP_S", () => {
    const result = evaluateStop({ messages: [], elapsedS: 45, tokens: 0, cfg: CFG });
    expect(result).toBe("cap_time");
  });

  it("§5.1 row 4: cap_tokens fires at 70% of RUN_TOKEN_CAP", () => {
    const result = evaluateStop({ messages: [], elapsedS: 0, tokens: 42000, cfg: CFG });
    expect(result).toBe("cap_tokens");
  });

  it("§5.1 row 4: cap_tokens does not fire just below 70%", () => {
    const result = evaluateStop({ messages: [], elapsedS: 0, tokens: 41999, cfg: CFG });
    expect(result).toBeNull();
  });

  it("§5.1 row 5: repeat fires when the last message hash equals the previous message's hash", () => {
    const messages = [
      msg({ id: "1", seq: 1, from_role: "pm", act: "propose", body: "same body" }),
      msg({ id: "2", seq: 2, from_role: "pm", act: "propose", body: "same body" }),
    ];
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 0, cfg: CFG });
    expect(result).toBe("repeat");
  });

  it("§5.1 row 5: repeat does not fire when messages differ", () => {
    const messages = [
      msg({ id: "1", seq: 1, from_role: "pm", act: "propose", body: "one" }),
      msg({ id: "2", seq: 2, from_role: "pm", act: "propose", body: "two" }),
    ];
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 0, cfg: CFG });
    expect(result).toBeNull();
  });

  it("§5.1: returns null when no guard fires", () => {
    const messages = [msg({ id: "1", seq: 1 })];
    const result = evaluateStop({ messages, elapsedS: 1, tokens: 1, cfg: CFG });
    expect(result).toBeNull();
  });

  it("§5.1: table-order tie-break — exactly 6 messages AND 45s returns cap_messages (row 2 before row 3)", () => {
    const messages = Array.from({ length: 6 }, (_, i) => msg({ id: `${i}`, seq: i }));
    const result = evaluateStop({ messages, elapsedS: 45, tokens: 0, cfg: CFG });
    expect(result).toBe("cap_messages");
  });

  it("§5.1: table-order tie-break — cap_time before cap_tokens", () => {
    const result = evaluateStop({ messages: [], elapsedS: 45, tokens: 42000, cfg: CFG });
    expect(result).toBe("cap_time");
  });

  it("§5.1: table-order tie-break — cap_tokens before repeat", () => {
    const messages = [
      msg({ id: "1", seq: 1, from_role: "pm", act: "propose", body: "same" }),
      msg({ id: "2", seq: 2, from_role: "pm", act: "propose", body: "same" }),
    ];
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 42000, cfg: CFG });
    expect(result).toBe("cap_tokens");
  });

  it("§5.1: DEBATE_MSG_CAP counts all persisted messages including office", () => {
    const messages = [
      msg({ id: "0", seq: 0, from_role: "office" }),
      ...Array.from({ length: 5 }, (_, i) => msg({ id: `${i + 1}`, seq: i + 1 })),
    ];
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 0, cfg: CFG });
    expect(result).toBe("cap_messages");
  });
});

describe("messageHash", () => {
  it("hashes `${from_role}|${act}|${body}` with sha-256 hex", () => {
    const m = { from_role: "pm" as const, act: "propose" as const, body: "hello" };
    const expected = createHash("sha256").update("pm|propose|hello").digest("hex");
    expect(messageHash(m)).toBe(expected);
  });

  it("differs when body differs", () => {
    expect(messageHash({ from_role: "pm", act: "propose", body: "a" })).not.toBe(
      messageHash({ from_role: "pm", act: "propose", body: "b" }),
    );
  });
});

describe("closedChains (§5.1 hop cap: hops=3 closes a chain but is not a stop reason)", () => {
  it("TC-025: marks a chain closed once its depth reaches hops=3", () => {
    const messages: Envelope[] = [
      msg({ id: "1", seq: 1, hops: 0, reply_to: null }),
      msg({ id: "2", seq: 2, hops: 1, reply_to: "1" }),
      msg({ id: "3", seq: 3, hops: 2, reply_to: "2" }),
      msg({ id: "4", seq: 4, hops: 3, reply_to: "3" }),
    ];
    const closed = closedChains(messages);
    expect(closed.has("4")).toBe(true);
  });

  it("does not mark messages below the hop cap as closed", () => {
    const messages: Envelope[] = [
      msg({ id: "1", seq: 1, hops: 0, reply_to: null }),
      msg({ id: "2", seq: 2, hops: 1, reply_to: "1" }),
      msg({ id: "3", seq: 3, hops: 2, reply_to: "2" }),
    ];
    const closed = closedChains(messages);
    expect(closed.size).toBe(0);
  });

  it("hop-3 closed chain is not itself a stop reason", () => {
    const messages: Envelope[] = [
      msg({ id: "1", seq: 1, hops: 0, reply_to: null, body: "one" }),
      msg({ id: "2", seq: 2, hops: 1, reply_to: "1", body: "two" }),
      msg({ id: "3", seq: 3, hops: 2, reply_to: "2", body: "three" }),
      msg({ id: "4", seq: 4, hops: 3, reply_to: "3", body: "four" }),
    ];
    const result = evaluateStop({ messages, elapsedS: 0, tokens: 0, cfg: CFG });
    expect(result).toBeNull();
  });
});
