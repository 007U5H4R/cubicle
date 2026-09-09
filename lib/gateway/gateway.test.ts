import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GatewayError, TIMEOUT_MS, createGateway, type Transport } from "./index";
const models = { agent: "agent-model", orchestrator: "orch-model" };
const schema = z.object({ next: z.string() });
const ok = (text: string) => ({ text, usage: { input: 0, output: 0 }, sources: [] });
function stub(overrides: Partial<Transport>): Transport {
  return { async generate() { return ok("{}"); }, async *generateStream() { yield { usage: { input: 0, output: 0 } }; }, ...overrides };
}
describe("gateway.chat", () => {
  it("returns validated JSON and usage", async () => {
    const gw = createGateway(stub({ async generate() { return { text: '{"next":"pm"}', usage: { input: 10, output: 2 }, sources: [] }; } }), models);
    await expect(gw.chat("orchestrator", "s", "u", schema, {})).resolves.toEqual({ data: { next: "pm" }, usage: { input: 10, output: 2 } });
  });
  it("uses the orchestrator model for orchestrator calls and the agent model otherwise", async () => {
    const seen: string[] = [];
    const gw = createGateway(stub({ async generate(r) { seen.push(r.model); return ok('{"next":"pm"}'); } }), models);
    await gw.chat("orchestrator", "s", "u", schema, {}); await gw.chat("agent", "s", "u", schema, {});
    expect(seen).toEqual(["orch-model", "agent-model"]);
  });
  it("times out -> GatewayError timeout, no retry", async () => {
    vi.useFakeTimers();
    const generate = vi.fn((r: { signal: AbortSignal }) => new Promise<never>((_, rej) => r.signal.addEventListener("abort", () => rej(r.signal.reason))));
    const gw = createGateway(stub({ generate: generate as unknown as Transport["generate"] }), models);
    const p = gw.chat("orchestrator", "s", "u", schema, {});
    const assertion = expect(p).rejects.toMatchObject({ kind: "timeout" });
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS.orchestrator + 1);
    await assertion; expect(generate).toHaveBeenCalledTimes(1); vi.useRealTimers();
  });
  it("retries once on a transient error then succeeds", async () => {
    let n = 0;
    const gw = createGateway(stub({ async generate() { if (n++ === 0) throw new Error("503 UNAVAILABLE"); return ok('{"next":"pm"}'); } }), models);
    await expect(gw.chat("agent", "s", "u", schema, {})).resolves.toMatchObject({ data: { next: "pm" } }); expect(n).toBe(2);
  });
  it("surfaces invalid JSON as invalid_output without heuristics", async () => {
    const gw = createGateway(stub({ async generate() { return ok("```json {\"next\":\"pm\"}```"); } }), models);
    await expect(gw.chat("agent", "s", "u", schema, {})).rejects.toMatchObject({ kind: "invalid_output" });
  });
  it("surfaces schema violations as invalid_output", async () => {
    const gw = createGateway(stub({ async generate() { return ok('{"nope":1}'); } }), models);
    await expect(gw.chat("agent", "s", "u", schema, {})).rejects.toBeInstanceOf(GatewayError);
  });
});
describe("gateway.stream", () => {
  it("yields deltas then one done with usage, and attaches search only when grounded", async () => {
    const flags: (boolean | undefined)[] = [];
    const gw = createGateway(stub({ async *generateStream(r) { flags.push(r.grounded); yield { text: "a" }; yield { text: "b" }; yield { usage: { input: 3, output: 2 }, sources: [{ title: "t", url: "https://x" }] }; } }), models);
    const out = []; for await (const c of gw.stream("artifact", "s", "u")) out.push(c);
    expect(out).toEqual([{ type: "delta", text: "a" }, { type: "delta", text: "b" }, { type: "done", usage: { input: 3, output: 2 }, sources: [{ title: "t", url: "https://x" }] }]);
    for await (const _ of gw.stream("grounded", "s", "u")) { /* drain */ }
    expect(flags).toEqual([false, true]);
  });
});
