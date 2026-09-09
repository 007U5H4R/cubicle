import "server-only";

const HEARTBEAT_MS = 15_000;

export interface Sse {
  response: Response;
  send(type: string, payload: unknown): void;
  close(): void;
}

/** One SSE stream for a run: `event: <type>\nid: <seq>\ndata: <json>\n\n` frames, plus a 15s comment heartbeat. */
export function createSse(runId: string): Sse {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let seq = 0;

  const write = (chunk: string) => {
    // Swallow write errors after the client disconnects — the run must keep going regardless.
    void writer.write(encoder.encode(chunk)).catch(() => {});
  };

  const heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);

  function send(type: string, payload: unknown): void {
    seq += 1;
    const data = JSON.stringify({ run_id: runId, seq, type, payload });
    write(`event: ${type}\nid: ${seq}\ndata: ${data}\n\n`);
  }

  function close(): void {
    clearInterval(heartbeat);
    void writer.close().catch(() => {});
  }

  const response = new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });

  return { response, send, close };
}
