import { describe, expect, it } from "vitest";
import { track, type EventSink } from "./events";
function memSink() { const rows: unknown[] = []; const sink: EventSink = { async insert(r) { rows.push(r); } }; return { sink, rows }; }
const ctx = { anonSessionId: "00000000-0000-0000-0000-000000000001" };
describe("track", () => {
  it("drops unknown event names", async () => {
    const { sink, rows } = memSink();
    expect(await track(sink, "nope" as never, {} as never, ctx)).toBe(false);
    expect(rows).toEqual([]);
  });
  it("writes allowed events and strips unknown properties", async () => {
    const { sink, rows } = memSink();
    expect(await track(sink, "run_started", { queued: true, extra: 1 } as never, ctx)).toBe(true);
    expect(rows[0]).toMatchObject({ name: "run_started", props: { queued: true } });
    expect((rows[0] as { props: object }).props).not.toHaveProperty("extra");
  });
  it("rejects invalid enum values", async () => {
    const { sink, rows } = memSink();
    expect(await track(sink, "run_failed", { phase: "deliver", reason: "bad" } as never, ctx)).toBe(false);
    expect(rows).toEqual([]);
  });
});
