import type { z } from "zod";
import { GatewayError, TIMEOUT_MS, type CallKind, type Gateway, type Transport } from "./types";
export * from "./types";

function isTransient(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /429|500|503|ECONNRESET|fetch failed|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
}
function withTimeout(kind: CallKind, outer?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new GatewayError("timeout", `${kind} call exceeded ${TIMEOUT_MS[kind]} ms`)), TIMEOUT_MS[kind]);
  outer?.addEventListener("abort", () => ctl.abort(outer.reason), { once: true });
  return { signal: ctl.signal, clear: () => clearTimeout(t) };
}
async function once<T>(kind: CallKind, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const { signal, clear } = withTimeout(kind, outer);
  try { return await fn(signal); }
  catch (e) { if (signal.aborted && signal.reason instanceof GatewayError) throw signal.reason; throw e; }
  finally { clear(); }
}
async function retrying<T>(kind: CallKind, outer: AbortSignal | undefined, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  try { return await once(kind, outer, fn); }
  catch (e) {
    if (e instanceof GatewayError && e.kind === "timeout") throw e;
    if (!isTransient(e)) throw new GatewayError("fatal", `${kind} call failed`, { cause: e });
    try { return await once(kind, outer, fn); }
    catch (e2) { throw new GatewayError(e2 instanceof GatewayError ? e2.kind : "transient", `${kind} call failed after retry`, { cause: e2 }); }
  }
}
export function createGateway(transport: Transport, models: { agent: string; orchestrator: string }): Gateway {
  return {
    async chat(kind, system, user, schema, jsonSchema, opts) {
      const model = kind === "orchestrator" ? models.orchestrator : models.agent;
      const r = await retrying(kind, opts?.signal, (signal) => transport.generate({ model, system, user, responseSchema: jsonSchema, signal }));
      let json: unknown;
      try { json = JSON.parse(r.text); } catch { throw new GatewayError("invalid_output", `${kind} returned non-JSON output`); }
      const parsed = schema.safeParse(json);
      if (!parsed.success) throw new GatewayError("invalid_output", `${kind} output failed validation: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
      return { data: parsed.data, usage: r.usage };
    },
    async *stream(kind, system, user, opts) {
      const { signal, clear } = withTimeout(kind, opts?.signal);
      try {
        for await (const c of transport.generateStream({ model: models.agent, system, user, grounded: kind === "grounded", maxOutputTokens: opts?.maxOutputTokens, signal })) {
          if (c.text) yield { type: "delta", text: c.text };
          if (c.usage) yield { type: "done", usage: c.usage, sources: c.sources ?? [] };
        }
      } catch (e) { if (signal.aborted && signal.reason instanceof GatewayError) throw signal.reason; throw e; }
      finally { clear(); }
    },
  };
}
