import type { AgentOutput, Role } from "@/lib/engine/envelope";
import type { Source, Usage } from "@/lib/gateway";
import { HEADINGS, type ArtifactType } from "@/lib/prompts/headings";

// TSK-09.1 — the replay fixture FORMAT plus one hand-built synthetic fixture. A fixture captures one
// full run's model responses so the stub gateway (stub-gateway.ts) can replay them deterministically
// with no network and no spend. This module is data + types only; it imports no model SDK.

/** One orchestrator decision, as decideNext validates it (orchestratorDecisionSchema: {next, brief}). */
export interface OrchestratorStep {
  next: Role | "done";
  brief: string;
}

/** One recorded artifact stream: the delta sequence, the terminal usage, and grounding metadata. */
export interface ArtifactStream {
  deltas: string[];
  usage: Usage;
  grounded: boolean;
  sources: Source[];
}

/**
 * A recorded run: every orchestrator decision (in decideNext order), every agent envelope (in agent
 * chat order), and every artifact stream (keyed by §10 type). `usage` is the flat token count the
 * stub reports per orchestrator / agent chat — kept off the real transport so CI never spends.
 */
export interface ReplayFixture {
  idea: string;
  orchestrator: OrchestratorStep[];
  agents: AgentOutput[];
  artifacts: Record<ArtifactType, ArtifactStream>;
  usage: { orchestrator: Usage; agent: Usage };
}

const u = (input: number, output: number): Usage => ({ input, output });

/** Build an artifact's markdown from its §10 headings so every required heading is present verbatim
 * in `content_md`, then split into two deltas to exercise the streaming/flush path. */
function artifactStream(type: ArtifactType, bodies: string[], grounded: boolean, sources: Source[], usage: Usage): ArtifactStream {
  const headings = HEADINGS[type];
  const sections = headings.map((h, i) => `## ${h}\n${bodies[i] ?? "Discussed in the debate."}`);
  const full = `# ${type.toUpperCase()}\n\n${sections.join("\n\n")}\n`;
  const mid = Math.ceil(full.length / 2);
  return { deltas: [full.slice(0, mid), full.slice(mid)], usage, grounded, sources };
}

/**
 * THE synthetic fixture. Scripted so the REAL debate loop (lib/engine/debate.ts) produces exactly six
 * messages, one of which is an objection (m5, researcher → pm) that is then answered (m6, pm, which the
 * engine links with reply_to = m5.id). Trace against debate.ts + rules.ts:
 *   turn 1 pm (rule 1) · turn 2 designer · turn 3 researcher (rule 2) · turn 4 developer  → all four spoke
 *   turn 5 researcher objection → pm (rule 3 clear: everyone at 1 turn) · turn 6 pm answers (rule 4)
 * The 7th orchestrator decision is "done", which stops the loop. No rule override fires (every pick is
 * already legal), so the briefs pass through unchanged. Synthetic text only — no secrets.
 */
export const SAMPLE_FIXTURE: ReplayFixture = {
  idea: "A reminder app for solo founders",
  orchestrator: [
    { next: "pm", brief: "Open with the problem, the user, and the value in plain words." },
    { next: "designer", brief: "React to the framing and sharpen the promise." },
    { next: "researcher", brief: "Name what already exists in the market." },
    { next: "developer", brief: "Say what is too big and what the smallest slice is." },
    { next: "researcher", brief: "Push back on the core assumption with a concrete reason." },
    { next: "pm", brief: "Answer the researcher's objection: revise or hold, and say why." },
    { next: "done", brief: "We have enough disagreement resolved to deliver." },
  ],
  agents: [
    { to: "team", act: "propose", subject: "Reminders for solo founders", body: "The value is fewer missed follow-ups. My unsure assumption: solo founders will pay monthly for this." },
    { to: "team", act: "propose", subject: "Sharper promise for the page", body: "The promise should be concrete: never drop a follow-up again. Let us keep the headline about the missed-thread pain." },
    { to: "team", act: "propose", subject: "Market already has reminder tools", body: "Calendar apps and CRMs already remind people. Solo founders lean on free tools, which shapes willingness to pay." },
    { to: "team", act: "propose", subject: "Cut the CRM, ship reminders only", body: "A full CRM is too big for v1. The smallest slice is a nudge on threads with no reply, testing the pay assumption." },
    { to: "pm", act: "objection", subject: "Monthly pricing assumption is weak", body: "I object: free calendar reminders already cover this, so a monthly fee is a hard sell. What makes founders switch and pay?" },
    { to: "team", act: "propose", subject: "Revised: charge on saved deals", body: "You are right on price. I revise: tie value to recovered deals, not a flat monthly fee, and prove it before charging." },
  ],
  artifacts: {
    prd: artifactStream(
      "prd",
      [
        "Solo founders lose deals when follow-ups slip through the cracks.",
        "Solo founders juggling many open threads with no assistant.",
        "A nudge on threads that have gone quiet, tied to recovered deals.",
        "In: silent-thread reminders. Out: a full CRM and pipeline reporting.",
        "Follow-ups recovered per week per founder.",
        "Whether founders will pay monthly, or only for recovered deals.",
      ],
      false,
      [],
      u(300, 120),
    ),
    scan: artifactStream(
      "scan",
      [
        "Calendar reminders, lightweight CRMs, and manual inbox flags.",
        "We win on the silent-thread niche, not on breadth of features.",
        "Confidence is moderate; incumbents are free but generic.",
      ],
      true,
      [{ title: "Reminder Incumbent", url: "https://incumbent.test" }],
      u(360, 140),
    ),
    copy: artifactStream(
      "copy",
      [
        "Never drop a follow-up again.",
        "Reminders for the threads that quietly went cold.",
        "Catch silent threads, recover deals, stay solo-lean.",
        "Start free, pay when it saves you a deal.",
        "\"I already use a calendar\" — calendars do not watch replies. \"Too pricey\" — you pay on results.",
      ],
      false,
      [],
      u(280, 110),
    ),
    plan: artifactStream(
      "plan",
      [
        "Detect threads with no reply in N days and nudge the founder.",
        "Next.js, a mail/API webhook, and a small Postgres store.",
        "Auth, inbox connect, silence detector, nudge UI, results log — a day each.",
        "Cut the CRM and analytics; they do not test the pay assumption.",
        "Riskiest: that founders pay when a nudge recovers a deal.",
      ],
      false,
      [],
      u(320, 130),
    ),
  },
  usage: { orchestrator: u(200, 20), agent: u(400, 60) },
};
