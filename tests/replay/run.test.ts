import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventSink } from "@/lib/events";
import type { DebateCfg } from "@/lib/engine/debate";
import type { Envelope } from "@/lib/engine/envelope";
import { loadRunState, type RunState } from "@/lib/engine/state";
import { runOne } from "@/lib/engine/run";
import { ARTIFACT_TYPES, HEADINGS, type ArtifactType } from "@/lib/prompts/headings";
import { recordingGateway } from "./recorder";
import { makeStubGateway } from "./stub-gateway";
import { SAMPLE_FIXTURE } from "./fixture";

// TSK-09.2 — the network-free full-run replay test. Drives runOne (debate → deliver → finalize) with
// the stub gateway + an in-memory db double, proving the whole engine on every CI push with no spend,
// and asserts resume-from-database parity. The stub IS the gateway, so the real @google/genai
// transport is never constructed (TC-040); a fetch guard makes that failure loud.

type Row = Record<string, unknown>;
type Table = "runs" | "messages" | "artifacts";

// Real column sets from supabase/migrations/0001_init.sql — insert/upsert/update reject any key
// outside these (mirroring PostgREST's PGRST204), so the `to`-column regression is caught offline.
const COLUMNS: Record<Table, ReadonlySet<string>> = {
  runs: new Set(["id", "anon_session_id", "owner_user_id", "idea", "status", "created_at", "started_at", "finished_at", "stop_reason", "model_agent", "model_orchestrator", "tokens_in", "tokens_out", "cost_cents", "share_slug", "is_shared", "error"]),
  messages: new Set(["id", "run_id", "seq", "from_role", "to_role", "act", "subject", "body", "reply_to", "hops", "brief", "created_at"]),
  artifacts: new Set(["run_id", "type", "status", "content_md", "grounded", "sources", "tokens_in", "tokens_out", "created_at", "finished_at"]),
};

/**
 * In-memory Supabase double. Mirrors run.test.ts's writer double (column allowlist + PGRST204) and
 * EXTENDS its reader so loadRunState works: select() projects the requested columns, and eq() supports
 * .single(), .order(), and being awaited directly (a thenable that resolves to the filtered rows).
 */
function makeDb(seed: { runs: Row[]; messages?: Row[]; artifacts?: Row[] }) {
  const state = { runs: [...seed.runs], messages: [...(seed.messages ?? [])], artifacts: [...(seed.artifacts ?? [])] };
  const badKey = (name: Table, patch: Row) => Object.keys(patch).find((k) => !COLUMNS[name].has(k));
  const pgrst204 = (name: Table, col: string) => ({ error: { message: `Could not find the '${col}' column of '${name}' in the schema cache`, code: "PGRST204" } });

  function from(name: Table) {
    const rows = state[name];
    const project = (row: Row, cols: string): Row => {
      if (cols === "*") return { ...row };
      const out: Row = {};
      for (const key of cols.split(",").map((c) => c.trim())) out[key] = row[key];
      return out;
    };
    return {
      update(patch: Row) {
        const bad = badKey(name, patch);
        return {
          eq(col: string, val: unknown) { if (bad) return Promise.resolve(pgrst204(name, bad)); const row = rows.find((r) => r[col] === val); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); },
          match(criteria: Row) { if (bad) return Promise.resolve(pgrst204(name, bad)); const row = rows.find((r) => Object.entries(criteria).every(([k, v]) => r[k] === v)); if (row) Object.assign(row, patch); return Promise.resolve({ error: null }); },
        };
      },
      insert(row: Row) {
        const bad = badKey(name, row);
        if (bad) return Promise.resolve(pgrst204(name, bad));
        rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      upsert(row: Row) {
        const bad = badKey(name, row);
        if (bad) return Promise.resolve(pgrst204(name, bad));
        const existing = rows.find((r) => r.run_id === row.run_id && r.type === row.type);
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        return Promise.resolve({ error: null });
      },
      select(cols = "*") {
        return {
          eq(col: string, val: unknown) {
            const matches = () => rows.filter((r) => r[col] === val);
            return {
              single() { const r = rows.find((x) => x[col] === val); return Promise.resolve(r ? { data: project(r, cols), error: null } : { data: null, error: { message: "not found" } }); },
              order(ocol: string, opts?: { ascending?: boolean }) {
                const dir = opts?.ascending === false ? -1 : 1;
                const sorted = [...matches()].sort((a, b) => (Number(a[ocol]) - Number(b[ocol])) * dir).map((r) => project(r, cols));
                return Promise.resolve({ data: sorted, error: null });
              },
              then<T>(resolve: (v: { data: Row[]; error: null }) => T) { return Promise.resolve({ data: matches().map((r) => project(r, cols)), error: null }).then(resolve); },
            };
          },
        };
      },
    };
  }
  return { db: { from } as unknown as SupabaseClient, state };
}

function sseDouble() {
  const events: { type: string; payload: unknown }[] = [];
  return { events, send: (type: string, payload: unknown) => events.push({ type, payload }), close: vi.fn() };
}

function stubSink(): EventSink { return { insert: vi.fn(async () => {}) }; }

// Caps generous enough that the fixture's 6 messages + 4 artifacts never trip a stop guard. A
// constant clock keeps every timestamp deterministic, keeps elapsed at 0 (no office steer, no wall
// cap), and lets the resume assertion compute exact started_at/finished_at.
const NOW = 1000;
const DEBATE_CFG: DebateCfg = { DEBATE_MSG_CAP: 20, DEBATE_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };
const DELIVER_CFG = { RUN_WALL_CAP_S: 600, RUN_TOKEN_CAP: 1_000_000 };
const EXPECTED_SPEAKERS = ["pm", "designer", "researcher", "developer", "researcher", "pm"] as const;

const payloadType = (e: { payload: unknown }) => (e.payload as { type?: string }).type;
const artifactEventTypes = (events: { type: string; payload: unknown }[], artifact: ArtifactType) =>
  events.filter((e) => payloadType(e) === artifact).map((e) => e.type);

describe("replay: full run against the recorded fixture (no network, no spend)", () => {
  // TC-040 guard: if any code reaches the real transport it calls fetch — make that throw loudly.
  let fetchGuard: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchGuard = vi.fn(() => { throw new Error("network reached: the replay stub must serve every gateway call"); });
    vi.stubGlobal("fetch", fetchGuard);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function runFixture() {
    const { db, state } = makeDb({ runs: [{ id: "r1", idea: SAMPLE_FIXTURE.idea, anon_session_id: "s1", status: "queued", is_shared: false, share_slug: null }] });
    const sse = sseDouble();
    // The stub is injected as the whole gateway — defaultDeps() (which builds the real transport) is
    // never called, so no @google/genai client is constructed.
    const deps = { db, gateway: makeStubGateway(SAMPLE_FIXTURE), sink: stubSink(), now: () => NOW };
    return { db, state, sse, deps };
  }

  it("drives the debate to 6 messages incl. one answered objection, delivers 4 artifacts, and completes", async () => {
    const { state, sse, deps } = runFixture();
    await runOne("r1", sse, deps, DEBATE_CFG, DELIVER_CFG);

    // --- messages: exactly 6, seq 1..6, one objection that is answered by a later reply_to ---
    const messages = [...state.messages].sort((a, b) => Number(a.seq) - Number(b.seq)) as unknown as Envelope[];
    expect(messages).toHaveLength(6);
    expect(messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(messages.map((m) => m.from_role)).toEqual(EXPECTED_SPEAKERS);
    // Persisted rows carry to_role, never the wire-only `to` (PGRST204 regression guard).
    for (const m of messages) expect(m).not.toHaveProperty("to");

    const objections = messages.filter((m) => m.act === "objection");
    expect(objections).toHaveLength(1);
    const objection = objections[0];
    expect(objection.seq).toBe(5);
    expect(objection.to_role).toBe("pm");
    // The objection is answered: a later message replies to it (reply_to = objection id, hops incremented).
    const answer = messages.find((m) => m.reply_to === objection.id);
    expect(answer).toBeDefined();
    expect(answer!.seq).toBe(6);
    expect(answer!.from_role).toBe("pm");
    expect(answer!.hops).toBe(objection.hops + 1);

    // --- artifacts: four done, each content_md carries its §10 headings; scan grounded with sources ---
    expect(state.artifacts).toHaveLength(4);
    for (const type of ARTIFACT_TYPES) {
      const row = state.artifacts.find((a) => a.type === type)!;
      expect(row.status).toBe("done");
      for (const heading of HEADINGS[type]) expect(String(row.content_md)).toContain(heading);
    }
    const scan = state.artifacts.find((a) => a.type === "scan")!;
    expect(scan.grounded).toBe(true);
    expect(scan.sources).toEqual([{ title: "Reminder Incumbent", url: "https://incumbent.test" }]);

    // --- run row completes ---
    expect(state.runs[0]).toMatchObject({ status: "complete", stop_reason: "done" });
    expect(Number(state.runs[0].tokens_in)).toBeGreaterThan(0);
    expect(Number(state.runs[0].cost_cents)).toBeGreaterThan(0);

    // --- SSE sequence: run.status(debate)/message ×6, run.status(deliver), per-desk delta…done, run.done ---
    const events = sse.events;
    for (let i = 0; i < 6; i++) {
      expect(events[2 * i]).toMatchObject({ type: "run.status", payload: { status: "running", phase: "debate", thinking: EXPECTED_SPEAKERS[i] } });
      expect(events[2 * i + 1]).toMatchObject({ type: "message", payload: { seq: i + 1 } });
    }
    expect(events[12]).toEqual({ type: "run.status", payload: { status: "running", phase: "deliver" } });
    // The deliver run.status precedes every artifact event; run.done is last and singular.
    const firstArtifactIdx = events.findIndex((e) => e.type.startsWith("artifact."));
    expect(firstArtifactIdx).toBe(13);
    expect(events.at(-1)).toMatchObject({ type: "run.done", payload: { status: "complete" } });
    expect(events.filter((e) => e.type === "run.done")).toHaveLength(1);
    for (const type of ARTIFACT_TYPES) {
      const desk = artifactEventTypes(events, type);
      expect(desk.at(-1)).toBe("artifact.done");
      expect(desk.slice(0, -1).every((t) => t === "artifact.delta")).toBe(true);
      expect(desk).toContain("artifact.delta");
    }
    expect(sse.close).toHaveBeenCalledOnce();

    // TC-040: no gateway call ever reached the network.
    expect(fetchGuard).not.toHaveBeenCalled();
  });

  it("TC-041 resume parity: loadRunState rebuilds the exact state the stream carried, even after a mid-run client disconnect", async () => {
    const { db, state, sse, deps } = runFixture();

    // Model the client disconnect: a consumer that stops reading after the 3rd message. The engine
    // (runOne) does not depend on the consumer — the sse double keeps collecting and runOne completes
    // regardless — so the database ends up fully populated whether or not anyone was still listening.
    let delivered = 0;
    let messagesSeen = 0;
    const consumer = { seen: [] as { type: string; payload: unknown }[], connected: true };
    const disconnectingSse = {
      send: (type: string, payload: unknown) => {
        sse.send(type, payload);
        delivered++;
        if (type === "message") messagesSeen++;
        if (consumer.connected) consumer.seen.push({ type, payload });
        if (messagesSeen >= 3) consumer.connected = false; // client goes away after message 3
      },
      close: sse.close,
    };
    await runOne("r1", disconnectingSse, deps, DEBATE_CFG, DELIVER_CFG);

    // The consumer stopped early…
    expect(consumer.seen.filter((e) => e.type === "message")).toHaveLength(3);
    expect(delivered).toBeGreaterThan(consumer.seen.length);
    // …but the engine still finished the whole run: 6 messages + 4 artifacts persisted.
    expect(state.messages).toHaveLength(6);
    expect(state.artifacts).toHaveLength(4);

    // Assemble the expected state purely from the FULL streamed event log (what a client that never
    // disconnected would have rebuilt), then assert the db-rebuilt state deep-equals it.
    const iso = new Date(NOW).toISOString();
    // The engine strips the wire-only `to` before persisting; mirror that to rebuild the stored rows.
    const stripTo = (env: Envelope): Record<string, unknown> => { const clone: Record<string, unknown> = { ...env }; delete clone.to; return clone; };
    const expectedMessages = sse.events.filter((e) => e.type === "message").map((e) => stripTo(e.payload as Envelope));

    const expectedArtifacts: Record<string, unknown> = {};
    for (const type of ARTIFACT_TYPES) {
      const content = sse.events.filter((e) => e.type === "artifact.delta" && payloadType(e) === type).map((e) => (e.payload as { text: string }).text).join("");
      const done = sse.events.find((e) => e.type === "artifact.done" && payloadType(e) === type)!.payload as { grounded: boolean; sources: unknown[] };
      expectedArtifacts[type] = { status: "done", content_md: content, grounded: done.grounded, sources: done.sources };
    }

    const expected: RunState = {
      run: { id: "r1", idea: SAMPLE_FIXTURE.idea, status: "complete", stop_reason: "done", started_at: iso, finished_at: iso, is_shared: false, share_slug: null, anon_session_id: "s1", owner: false },
      messages: expectedMessages as unknown as Envelope[],
      artifacts: expectedArtifacts as RunState["artifacts"],
    };

    const rebuilt = await loadRunState(db, "r1");
    expect(rebuilt).toEqual(expected);
  });

  it("the recorder round-trips: recording a run then replaying the captured fixture reproduces it", async () => {
    // Offline proof that recordingGateway captures the fixture format faithfully — wrap the stub as
    // the "real" gateway, record a full run, rebuild the fixture, and replay THAT into a second run.
    const first = makeDb({ runs: [{ id: "r1", idea: SAMPLE_FIXTURE.idea, anon_session_id: "s1", status: "queued", is_shared: false, share_slug: null }] });
    const rec = recordingGateway(makeStubGateway(SAMPLE_FIXTURE));
    await runOne("r1", sseDouble(), { db: first.db, gateway: rec.gateway, sink: stubSink(), now: () => NOW }, DEBATE_CFG, DELIVER_CFG);

    const captured = rec.build(SAMPLE_FIXTURE.idea);
    expect(captured.orchestrator).toEqual(SAMPLE_FIXTURE.orchestrator);
    expect(captured.agents).toEqual(SAMPLE_FIXTURE.agents);

    // Replay the captured fixture — it must drive an identical run (same 6 messages, 4 done artifacts).
    const second = makeDb({ runs: [{ id: "r1", idea: captured.idea, anon_session_id: "s1", status: "queued", is_shared: false, share_slug: null }] });
    await runOne("r1", sseDouble(), { db: second.db, gateway: makeStubGateway(captured), sink: stubSink(), now: () => NOW }, DEBATE_CFG, DELIVER_CFG);
    expect(second.state.messages).toHaveLength(6);
    expect(second.state.runs[0]).toMatchObject({ status: "complete", stop_reason: "done" });
    for (const type of ARTIFACT_TYPES) expect(second.state.artifacts.find((a) => a.type === type)?.status).toBe("done");
  });
});
