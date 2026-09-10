import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../lib/config";
import { runDebate } from "../lib/engine/debate";
import { runDeliver } from "../lib/engine/deliver";
import type { RunDeps, RunSse } from "../lib/engine/run";
import { createGateway } from "../lib/gateway";
import { realTransport } from "../lib/gateway/transport";
import { recordingGateway } from "../tests/replay/recorder";

// TSK-09.1 — live fixture recorder (exercised live later, not in CI). Drives the real §5 debate and
// §A6 deliver phases through a recording wrapper over the REAL gateway, then writes the captured
// ReplayFixture to tests/replay/fixtures/sample-run.json. Run manually with a funded key:
//   GEMINI_API_KEY=... tsx scripts/fixture-record.ts "A reminder app for solo founders"
// It talks to the model (it SPENDS); it is never part of `pnpm test`. It uses no database — the debate
// and deliver engines are driven against no-op sinks/sse so only the gateway traffic is recorded.

const idea = process.argv[2] ?? "A reminder app for solo founders";
const OUT = path.resolve(__dirname, "../tests/replay/fixtures/sample-run.json");

const cfg = loadConfig();
const real = createGateway(realTransport(cfg.GEMINI_API_KEY), { agent: cfg.MODEL_AGENT, orchestrator: cfg.MODEL_ORCHESTRATOR });
const recorder = recordingGateway(real);

// Minimal no-op doubles: recording needs the gateway traffic only, not persistence. The db is a
// permissive stub whose writes/reads are inert (the engines still call it, so it must not throw).
const inertResult = Promise.resolve({ error: null, data: null });
const chainable: Record<string, unknown> = {};
for (const m of ["select", "eq", "match", "order", "single", "insert", "upsert", "update"]) {
  chainable[m] = () => chainable;
}
// Make the chain awaitable and terminal calls resolve.
(chainable as { then: unknown }).then = (res: (v: unknown) => unknown) => inertResult.then(res);
const db = { from: () => chainable } as unknown as RunDeps["db"];

const sse: RunSse = { send: () => {}, close: () => {} };
const sink = { insert: async () => {} };
const deps: RunDeps = { db, gateway: recorder.gateway, sink, now: () => Date.now() };

const debateCfg = { DEBATE_MSG_CAP: 12, DEBATE_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };
const deliverCfg = { RUN_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };

(async () => {
  const startedAt = deps.now();
  const outcome = await runDebate({ runId: "record", idea, anonSessionId: null, deps, sse, cfg: debateCfg, startedAt });
  await runDeliver({ runId: "record", idea, anonSessionId: null, transcript: outcome.messages, debateTokens: outcome.usage, deps, sse, cfg: deliverCfg, startedAt });
  const fixture = recorder.build(idea);
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(fixture, null, 2) + "\n");
  console.log(`wrote ${OUT} — ${fixture.orchestrator.length} decisions, ${fixture.agents.length} messages, ${Object.keys(fixture.artifacts).length} artifacts`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
