import { ROLES, type Envelope, type Role } from "./envelope";

// §5.2 orchestrator rules (re-checked in code). The orchestrator (a model, stubbed later)
// proposes `next`; this engine re-checks and overrides to the first legal speaker if the
// pick violates a rule, evaluated in rule-number order (1 wins over 2, 2 over 3, 3 over 4).

export interface RulesInput {
  pick: Role;
  brief: string;
  messages: Envelope[]; // office messages are ignored for turn counting
}

export interface SpeakerDecision {
  speaker: Role;
  brief: string;
  overrideRule?: 1 | 2 | 3 | 4;
}

function roleMessages(messages: Envelope[]): Envelope[] {
  return messages.filter((m): m is Envelope & { from_role: Role } => ROLES.includes(m.from_role as Role));
}

function turnCounts(messages: Envelope[]): Record<Role, number> {
  const counts = { pm: 0, researcher: 0, designer: 0, developer: 0 } as Record<Role, number>;
  for (const m of roleMessages(messages)) counts[m.from_role as Role]++;
  return counts;
}

function override(rule: 1 | 2 | 3 | 4, speaker: Role, brief: string): SpeakerDecision {
  return { speaker, brief: `[override: rule ${rule}] ${brief}`, overrideRule: rule };
}

export function enforceRules(input: RulesInput): SpeakerDecision {
  const { pick, brief, messages } = input;
  const debate = roleMessages(messages);
  const counts = turnCounts(debate);
  const turnIndex = debate.length; // 0-based index of the turn about to happen

  // Rule 1: PM speaks first.
  if (turnIndex === 0) {
    return pick === "pm" ? { speaker: pick, brief } : override(1, "pm", brief);
  }

  // Rule 2: researcher speaks by turn 3 (turn index 2) if it hasn't spoken yet.
  if (turnIndex === 2 && counts.researcher === 0) {
    return pick === "researcher" ? { speaker: pick, brief } : override(2, "researcher", brief);
  }

  // Rule 3: nobody speaks twice until everyone has spoken once.
  const minTurns = Math.min(...ROLES.map((r) => counts[r]));
  if (counts[pick] > minTurns) {
    const firstAtMin = ROLES.find((r) => counts[r] === minTurns)!;
    return override(3, firstAtMin, brief);
  }

  // Rule 4: an objection/question addressed to a specific role is answered by that role next.
  const last = debate[debate.length - 1];
  if (last && (last.act === "question" || last.act === "objection") && last.to_role !== "team") {
    const addressee = last.to_role as Role;
    return pick === addressee ? { speaker: pick, brief } : override(4, addressee, brief);
  }

  return { speaker: pick, brief };
}
