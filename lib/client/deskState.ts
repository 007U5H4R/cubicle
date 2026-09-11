import type { DeskStateName, Role } from "@/components/office/Desk";
import type { Act } from "@/lib/engine/envelope";
import { ARTIFACT_ROLE, type ArtifactType } from "@/lib/prompts/headings";
import { artifactProgress } from "./artifactProgress";
import type { RunSnapshot } from "./runStore";

// TKT-12 Dispatch A — pure derivation of each role's desk state from a `RunSnapshot` (technical-plan
// §A4, verbatim). Dispatch B renders `DeskDerived` via `<Desk>`; this module owns no DOM/React.

export interface DeskDerived {
  state: DeskStateName;
  badgeAct?: Act;
  preview?: string;
  progress?: { done: number; total: number };
  /** Only meaningful for state === "failed": true = Phase-2 (deliver) artifact failure → show Retry;
   * false = Phase-1 (debate) failure → no retry. */
  retryable?: boolean;
}

const ROLES: Role[] = ["pm", "researcher", "designer", "developer"];

function artifactOf(role: Role): ArtifactType {
  return (Object.keys(ARTIFACT_ROLE) as ArtifactType[]).find((type) => ARTIFACT_ROLE[type] === role)!;
}

/** For `role`, the last message addressed to it that is a question/objection with no later reply
 * from `role` itself — the "waiting" trigger. `to_role === "team"` never matches (TC-047). */
function waitingBadge(snap: RunSnapshot, role: Role): Act | null {
  const messages = snap.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.to_role !== role) continue;
    if (m.act !== "question" && m.act !== "objection") continue;
    const answered = messages.slice(i + 1).some((later) => later.from_role === role);
    return answered ? null : m.act;
  }
  return null;
}

export function deriveDesks(snap: RunSnapshot, live: boolean): Record<Role, DeskDerived> {
  const result = {} as Record<Role, DeskDerived>;
  const newestMessage = snap.messages[snap.messages.length - 1];

  for (const role of ROLES) {
    const type = artifactOf(role);
    const artifact = snap.artifacts[type];

    if (snap.terminal && snap.run?.status === "failed" && artifact.status === "failed") {
      result[role] = { state: "failed", retryable: true };
      continue;
    }
    // CR-001: a `done` artifact always renders done, even under a failed run — hydrate() infers
    // failedPhase as "debate" whenever no artifact is marked `failed` (lib/client/runStore.ts
    // hydrate), which is wrong for a run-level failure during deliver that struck after some
    // artifacts already completed. Checked ABOVE the blanket debate-phase fail guard below so those
    // completed artifacts don't get hidden as unretryable failures.
    if (artifact.status === "done") {
      result[role] = { state: "done" };
      continue;
    }
    if (snap.terminal && snap.run?.status === "failed" && snap.failedPhase === "debate") {
      result[role] = { state: "failed", retryable: false };
      continue;
    }
    if (artifact.status === "streaming") {
      const { done, total } = artifactProgress(type, artifact.content_md);
      result[role] = { state: "writing", progress: { done, total } };
      continue;
    }
    const badgeAct = waitingBadge(snap, role);
    if (badgeAct) {
      result[role] = { state: "waiting", badgeAct };
      continue;
    }
    if (live && newestMessage && newestMessage.from_role === role) {
      result[role] = { state: "speaking", preview: newestMessage.body };
      continue;
    }
    if (live && snap.thinking === role) {
      result[role] = { state: "thinking" };
      continue;
    }
    result[role] = { state: "idle" };
  }

  return result;
}
