import { describe, expect, it, vi } from "vitest";
import { openRunStream } from "./runStream";

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
}

function frame(type: string, payload: { run_id: string; seq: number; payload?: unknown }) {
  const data = JSON.stringify({ run_id: payload.run_id, seq: payload.seq, type, payload: payload.payload ?? null });
  return `event: ${type}\nid: ${payload.seq}\ndata: ${data}\n\n`;
}

function waitATick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("openRunStream", () => {
  it("fires onOpen once with the run_id from the first event, and onEvent per event", async () => {
    const res = sseResponse([
      ": ping\n\n",
      frame("run_started", { run_id: "run-1", seq: 1 }),
      frame("debate_message", { run_id: "run-1", seq: 2, payload: { text: "hi" } }),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(res);
    const onOpen = vi.fn();
    const onEvent = vi.fn();

    openRunStream({ idea: "an idea" }, { onOpen, onEvent }, fetchImpl);
    await waitATick();
    await waitATick();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith("run-1");
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/runs",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ idea: "an idea" }) }),
    );
  });

  it("calls onError with the parsed body on a 403 and never calls onOpen", async () => {
    const errorBody = { trigger: "limit", scope: "anonymous" };
    const res = new Response(JSON.stringify(errorBody), { status: 403 });
    const fetchImpl = vi.fn().mockResolvedValue(res);
    const onOpen = vi.fn();
    const onError = vi.fn();

    openRunStream({ idea: "an idea" }, { onOpen, onError }, fetchImpl);
    await waitATick();
    await waitATick();

    expect(onError).toHaveBeenCalledWith(403, errorBody);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
