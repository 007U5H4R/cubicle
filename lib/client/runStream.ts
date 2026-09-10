export type RunStreamEvent = { run_id: string; seq: number; type: string; payload: unknown };

export interface RunStreamHandlers {
  onEvent?: (e: RunStreamEvent) => void;
  /** Non-2xx POST response (400/403/5xx) — body is the parsed JSON, or null if parsing failed. */
  onError?: (status: number, body: unknown) => void;
  /** Fires once, on the first event that carries a run_id. */
  onOpen?: (runId: string) => void;
  onClose?: () => void;
}

/**
 * Opens the run SSE stream by POSTing to /api/runs and reading the response body as a stream.
 * Can't use EventSource here — it can't send a POST body — so this parses the `event:`/`id:`/`data:`
 * SSE framing by hand, tolerating the server's `: ping\n\n` heartbeat comments.
 */
export function openRunStream(
  body: { idea: string; resume_run_id?: string },
  handlers: RunStreamHandlers,
  fetchImpl: typeof fetch = globalThis.fetch,
): { close: () => void } {
  const controller = new AbortController();
  let opened = false;

  (async () => {
    let res: Response;
    try {
      res = await fetchImpl("/api/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) return;
      handlers.onError?.(0, err instanceof Error ? { message: err.message } : err);
      return;
    }

    if (!res.ok) {
      const parsed = await res.json().catch(() => null);
      handlers.onError?.(res.status, parsed);
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      handlers.onError?.(res.status, null);
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf("\n\n");
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleFrame(frame);
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        handlers.onError?.(0, err instanceof Error ? { message: err.message } : err);
      }
    } finally {
      handlers.onClose?.();
    }

    function handleFrame(frame: string) {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
      if (!dataLine) return; // heartbeat comment (": ping") or other non-data frame
      const raw = dataLine.slice(5).trim();
      let event: RunStreamEvent;
      try {
        event = JSON.parse(raw) as RunStreamEvent;
      } catch {
        return;
      }
      if (!opened && event.run_id) {
        opened = true;
        handlers.onOpen?.(event.run_id);
      }
      handlers.onEvent?.(event);
    }
  })();

  return {
    close() {
      controller.abort();
    },
  };
}
