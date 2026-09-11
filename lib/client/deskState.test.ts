import { describe, expect, it } from "vitest";
import type { Role } from "@/components/office/Desk";
import type { Envelope } from "@/lib/engine/envelope";
import { HEADINGS } from "@/lib/prompts/headings";
import { deriveDesks } from "./deskState";
import type { RunSnapshot } from "./runStore";

// TKT-12 Dispatch A — TC-047: deriveDesks state-machine coverage.

const RUN_ID = "r1";

function envelope(overrides: Partial<Envelope>): Envelope {
  return {
    id: "m1",
    run_id: RUN_ID,
    seq: 1,
    from_role: "pm",
    to: "team",
    to_role: "team",
    act: "propose",
    subject: "s",
    body: "hello from role",
    reply_to: null,
    hops: 0,
    brief: null,
    created_at: "2020-01-01T00:00:00.000Z",
    ...overrides,
  } as Envelope;
}

function snapshot(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    runId: RUN_ID,
    run: { id: RUN_ID, idea: "i", status: "running", stop_reason: null, started_at: null, finished_at: null, is_shared: false, share_slug: null, owner: false },
    messages: [],
    artifacts: {
      prd: { status: "pending", content_md: "", grounded: false, sources: [] },
      scan: { status: "pending", content_md: "", grounded: false, sources: [] },
      copy: { status: "pending", content_md: "", grounded: false, sources: [] },
      plan: { status: "pending", content_md: "", grounded: false, sources: [] },
    },
    phase: null,
    thinking: null,
    queue: null,
    wall_s: null,
    tokens: null,
    cost_cents: null,
    failedPhase: null,
    terminal: false,
    live: false,
    notFound: false,
    lastSeq: 0,
    ...overrides,
  };
}

describe("deriveDesks", () => {
  it("thinking hint -> that role thinking", () => {
    const snap = snapshot({ thinking: "researcher" });
    expect(deriveDesks(snap, true).researcher.state).toBe("thinking");
    expect(deriveDesks(snap, true).pm.state).toBe("idle");
  });

  it("newest message from a role -> speaking (while live)", () => {
    const snap = snapshot({ messages: [envelope({ from_role: "designer", body: "the newest body" })] });
    const desks = deriveDesks(snap, true);
    expect(desks.designer).toMatchObject({ state: "speaking", preview: "the newest body" });
  });

  it("a question/objection addressed to designer -> designer waiting with badgeAct; a later reply from designer clears it", () => {
    const question = envelope({ id: "q1", from_role: "pm", to_role: "designer", act: "question", seq: 1 });
    let snap = snapshot({ messages: [question] });
    expect(deriveDesks(snap, false).designer).toMatchObject({ state: "waiting", badgeAct: "question" });

    const reply = envelope({ id: "r1", from_role: "designer", to_role: "pm", act: "propose", seq: 2 });
    snap = snapshot({ messages: [question, reply] });
    const desks = deriveDesks(snap, false);
    expect(desks.designer.state).not.toBe("waiting");
  });

  it("to_role: team objection never yields waiting (TC-047)", () => {
    const objection = envelope({ from_role: "researcher", to_role: "team", act: "objection" });
    const snap = snapshot({ messages: [objection] });
    const desks = deriveDesks(snap, false);
    for (const role of Object.keys(desks) as Role[]) {
      expect(desks[role].state).not.toBe("waiting");
    }
  });

  it("artifact streaming -> writing with progress.total = HEADINGS[type].length; artifact.done -> done", () => {
    const snap = snapshot({
      artifacts: {
        prd: { status: "streaming", content_md: "partial", grounded: false, sources: [] },
        scan: { status: "done", content_md: "full", grounded: true, sources: [] },
        copy: { status: "pending", content_md: "", grounded: false, sources: [] },
        plan: { status: "pending", content_md: "", grounded: false, sources: [] },
      },
    });
    const desks = deriveDesks(snap, true);
    expect(desks.pm).toMatchObject({ state: "writing", progress: { done: 0, total: HEADINGS.prd.length } });
    expect(desks.researcher).toMatchObject({ state: "done" });
  });

  it("artifact streaming with 2 of 6 PRD headings in content_md -> progress.done = 2", () => {
    const md = "## Problem\nprose\n\n## Who it is for\nmore prose still streaming";
    const snap = snapshot({
      artifacts: {
        prd: { status: "streaming", content_md: md, grounded: false, sources: [] },
        scan: { status: "pending", content_md: "", grounded: false, sources: [] },
        copy: { status: "pending", content_md: "", grounded: false, sources: [] },
        plan: { status: "pending", content_md: "", grounded: false, sources: [] },
      },
    });
    const desks = deriveDesks(snap, true);
    expect(desks.pm).toMatchObject({ state: "writing", progress: { done: 2, total: 6 } });
  });

  it("terminal-failed + one artifact failed -> that desk failed retryable, others done", () => {
    const snap = snapshot({
      terminal: true,
      run: { id: RUN_ID, idea: "i", status: "failed", stop_reason: "model_error", started_at: null, finished_at: null, is_shared: false, share_slug: null, owner: false },
      failedPhase: "deliver",
      artifacts: {
        prd: { status: "done", content_md: "x", grounded: false, sources: [] },
        scan: { status: "done", content_md: "x", grounded: false, sources: [] },
        copy: { status: "failed", content_md: "", grounded: false, sources: [] },
        plan: { status: "done", content_md: "x", grounded: false, sources: [] },
      },
    });
    const desks = deriveDesks(snap, false);
    expect(desks.designer).toEqual({ state: "failed", retryable: true });
    expect(desks.pm.state).toBe("done");
    expect(desks.researcher.state).toBe("done");
    expect(desks.developer.state).toBe("done");
  });

  it("terminal-failed with failedPhase debate -> all desks failed, not retryable", () => {
    const snap = snapshot({
      terminal: true,
      run: { id: RUN_ID, idea: "i", status: "failed", stop_reason: "model_error", started_at: null, finished_at: null, is_shared: false, share_slug: null, owner: false },
      failedPhase: "debate",
    });
    const desks = deriveDesks(snap, false);
    for (const role of Object.keys(desks) as Role[]) {
      expect(desks[role]).toEqual({ state: "failed", retryable: false });
    }
  });

  it("live:false on a completed run -> all done (no lingering speaking/thinking)", () => {
    const snap = snapshot({
      live: false,
      terminal: true,
      thinking: null,
      run: { id: RUN_ID, idea: "i", status: "complete", stop_reason: "done", started_at: null, finished_at: null, is_shared: false, share_slug: null, owner: false },
      messages: [envelope({ from_role: "pm" })],
      artifacts: {
        prd: { status: "done", content_md: "x", grounded: false, sources: [] },
        scan: { status: "done", content_md: "x", grounded: false, sources: [] },
        copy: { status: "done", content_md: "x", grounded: false, sources: [] },
        plan: { status: "done", content_md: "x", grounded: false, sources: [] },
      },
    });
    const desks = deriveDesks(snap, false);
    for (const role of Object.keys(desks) as Role[]) {
      expect(desks[role].state).toBe("done");
    }
  });
});
