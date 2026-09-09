import { describe, expect, it } from "vitest";
import { createSse } from "./sse";

describe("createSse", () => {
  it("writes one well-formed SSE frame per send, with seq incrementing from 1", async () => {
    const { response, send, close } = createSse("r");
    send("message", { a: 1 });
    close();
    const body = await new Response(response.body).text();
    expect(body).toBe('event: message\nid: 1\ndata: {"run_id":"r","seq":1,"type":"message","payload":{"a":1}}\n\n');
  });

  it("sets the SSE response headers", () => {
    const { response, close } = createSse("r");
    close();
    expect(response.headers.get("Content-Type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("Cache-Control")).toBe("no-cache, no-transform");
    expect(response.headers.get("Connection")).toBe("keep-alive");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
  });

  it("increments seq across multiple sends and includes each event id", async () => {
    const { response, send, close } = createSse("r2");
    send("run.status", { status: "running" });
    send("run.done", { status: "complete" });
    close();
    const body = await new Response(response.body).text();
    expect(body).toBe(
      'event: run.status\nid: 1\ndata: {"run_id":"r2","seq":1,"type":"run.status","payload":{"status":"running"}}\n\n' +
        'event: run.done\nid: 2\ndata: {"run_id":"r2","seq":2,"type":"run.done","payload":{"status":"complete"}}\n\n',
    );
  });
});
