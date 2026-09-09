import { z } from "zod";
import { loadConfig } from "../lib/config";
import { createGateway } from "../lib/gateway";
import { realTransport } from "../lib/gateway/transport";
const cfg = loadConfig();
const gw = createGateway(realTransport(cfg.GEMINI_API_KEY), { agent: cfg.MODEL_AGENT, orchestrator: cfg.MODEL_ORCHESTRATOR });
const schema = z.object({ ok: z.boolean(), model_hint: z.string() });
const jsonSchema = { type: "object", properties: { ok: { type: "boolean" }, model_hint: { type: "string" } }, required: ["ok", "model_hint"] };
async function check(kind: "orchestrator" | "agent", model: string) {
  const t0 = Date.now();
  const r = await gw.chat(kind, "Reply with JSON only.", 'Return {"ok": true, "model_hint": "<your model family in three words>"}', schema, jsonSchema);
  console.log(JSON.stringify({ date: new Date().toISOString(), kind, model, latency_ms: Date.now() - t0, usage: r.usage, data: r.data }));
}
(async () => { await check("orchestrator", cfg.MODEL_ORCHESTRATOR); await check("agent", cfg.MODEL_AGENT); })().catch((e) => { console.error(e); process.exit(1); });
