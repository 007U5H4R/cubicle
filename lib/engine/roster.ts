import { ROLES, type Act, type Envelope, type Role } from "./envelope";

// §5.3 roster injection — computed by the engine, never a model.

export interface RosterLine {
  role: Role;
  turns: number;
  last_act: Act | null;
  stance: string | null;
}

/** Builds one roster line per role, in fixed order pm, researcher, designer, developer.
 * `office` messages are ignored (they carry no Role). */
export function buildRoster(messages: Envelope[]): RosterLine[] {
  return ROLES.map((role) => {
    const roleMessages = messages.filter((m) => m.from_role === role);
    const last = roleMessages[roleMessages.length - 1];
    return {
      role,
      turns: roleMessages.length,
      last_act: last ? last.act : null,
      stance: last ? last.subject : null,
    };
  });
}

const ROLE_WIDTH = 11;
const TURNS_WIDTH = 9;
const LAST_ACT_WIDTH = 19;

/** Renders the exact byte-stable roster block text (§5.3). Column widths are locked by
 * roster.test.ts so the orchestrator prompt prefix stays cache-stable (§8). */
export function formatRoster(lines: RosterLine[]): string {
  const header = "ROSTER (this supersedes any roster earlier in this conversation)";
  const rows = lines.map((l) => {
    const rolePart = l.role.padEnd(ROLE_WIDTH);
    const turnsPart = `turns:${l.turns}`.padEnd(TURNS_WIDTH);
    const lastActPart = `last_act:${l.last_act ?? "-"}`.padEnd(LAST_ACT_WIDTH);
    const stancePart = `stance:${l.stance ? `"${l.stance}"` : "-"}`;
    return `${rolePart}${turnsPart}${lastActPart}${stancePart}`;
  });
  return [header, ...rows].join("\n");
}
