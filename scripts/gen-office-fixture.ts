import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runOne } from "../lib/engine/run";
import { makeDb, sseDouble, stubSink } from "../tests/replay/harness";
import { makeStubGateway } from "../tests/replay/stub-gateway";
import { SAMPLE_FIXTURE } from "../tests/replay/fixture";
import type { RunStreamEvent } from "../lib/client/runStream";

// TKT-12 Dispatch A — generates tests/replay/fixtures/run-001.json: an ordered RunStreamEvent[]
// (the exact shape lib/client/runStore.ts's applyEvent consumes) so Dispatch B's `/dev/office` page
// can drive the whole desk-state machine with no server calls. Drives the SAME in-memory replay
// harness as tests/replay/run.test.ts — no network, no spend (the stub gateway IS the transport).
//
// Run via `pnpm gen:office-fixture` (see package.json — invokes tsx with `--conditions=react-server`
// so `import "server-only"` in lib/engine/* resolves to server-only's no-op `react-server` export
// condition instead of throwing; the guard itself is untouched).

const OUT = path.resolve(__dirname, "../tests/replay/fixtures/run-001.json");
const RUN_ID = "run-001";
const DEBATE_CFG = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };
const DELIVER_CFG = { RUN_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };
const NOW = 1000;

(async () => {
  const { db } = makeDb({ runs: [{ id: "r1", idea: SAMPLE_FIXTURE.idea, anon_session_id: "s1", status: "queued", is_shared: false, share_slug: null }] });
  const sse = sseDouble();
  const deps = { db, gateway: makeStubGateway(SAMPLE_FIXTURE), sink: stubSink(), now: () => NOW };

  await runOne("r1", sse, deps, DEBATE_CFG, DELIVER_CFG);

  const events: RunStreamEvent[] = sse.events.map((e, i) => ({ run_id: RUN_ID, seq: i + 1, type: e.type, payload: e.payload }));

  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(events, null, 2) + "\n");
  console.log(`wrote ${OUT} — ${events.length} events`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
