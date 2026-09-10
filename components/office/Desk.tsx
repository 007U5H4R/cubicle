import { RoleGlyph, type Role } from "./RoleGlyph";

export type { Role };
export type DeskStateName = "idle" | "thinking" | "speaking" | "waiting" | "writing" | "done" | "failed";

export interface DeskProps {
  role: Role;
  state: DeskStateName;
  badgeAct?: "propose" | "question" | "objection" | "agree" | "done";
  preview?: string;
  progress?: { done: number; total: number };
  onRetry?: () => void;
}

const ROLE_NAME: Record<Role, string> = {
  pm: "PM",
  researcher: "Researcher",
  designer: "Designer",
  developer: "Developer",
};

const ROLE_BORDER: Record<Role, string> = {
  pm: "border-role-pm/40",
  researcher: "border-role-researcher/40",
  designer: "border-role-designer/40",
  developer: "border-role-developer/40",
};

const ROLE_TEXT: Record<Role, string> = {
  pm: "text-role-pm",
  researcher: "text-role-researcher",
  designer: "text-role-designer",
  developer: "text-role-developer",
};

/**
 * The desk card. TKT-11 implements only the `idle` visual (Design.md §3.6); the other six states
 * fall back to the same idle look for now — TKT-12 gives each its own treatment. The props contract
 * is stable across TKT-12…15: do not add/remove props here.
 */
export function Desk({ role, state }: DeskProps) {
  return (
    <div
      data-testid={`desk-${role}`}
      data-role={role}
      data-state={state}
      className={`flex items-center gap-3 rounded-lg border-l-4 bg-surface p-4 ${ROLE_BORDER[role]}`}
    >
      <span className={`shrink-0 opacity-60 ${ROLE_TEXT[role]}`}>
        <RoleGlyph role={role} />
      </span>
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${ROLE_TEXT[role]}`}>{ROLE_NAME[role]}</div>
      </div>
      <span className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
        Ready
      </span>
    </div>
  );
}
