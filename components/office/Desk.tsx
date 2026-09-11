import type { CSSProperties, ReactNode } from "react";
import { RoleGlyph, type Role } from "./RoleGlyph";
import { Typewriter } from "./Typewriter";
import { ARTIFACT_ROLE, HEADINGS, type ArtifactType } from "@/lib/prompts/headings";

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
  pm: "border-role-pm",
  researcher: "border-role-researcher",
  designer: "border-role-designer",
  developer: "border-role-developer",
};

const ROLE_BORDER_40: Record<Role, string> = {
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

const ROLE_VAR: Record<Role, string> = {
  pm: "var(--role-pm)",
  researcher: "var(--role-researcher)",
  designer: "var(--role-designer)",
  developer: "var(--role-developer)",
};

/** Inverse of ARTIFACT_ROLE — which artifact a role's desk writes (same helper pattern as deskState.ts). */
function artifactOf(role: Role): ArtifactType {
  return (Object.keys(ARTIFACT_ROLE) as ArtifactType[]).find((type) => ARTIFACT_ROLE[type] === role)!;
}

function Spinner({ colorVar }: { colorVar: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="animate-spin">
      <circle cx="6" cy="6" r="4.5" stroke={colorVar} strokeOpacity="0.25" strokeWidth="1.6" />
      <path d="M10.5 6C10.5 3.51 8.49 1.5 6 1.5" stroke={colorVar} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ActIcon({ act }: { act: "propose" | "question" | "objection" | "agree" | "done" }) {
  if (act === "objection") {
    return (
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M6 1.2L11.2 10.4H0.8L6 1.2Z"
          stroke="var(--act-objection)"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
        <line x1="6" y1="4.6" x2="6" y2="7" stroke="var(--act-objection)" strokeWidth="1.2" strokeLinecap="round" />
        <circle cx="6" cy="8.6" r="0.6" fill="var(--act-objection)" />
      </svg>
    );
  }
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <circle cx="6" cy="6" r="5" stroke="var(--act-question)" strokeWidth="1.2" />
      <text x="6" y="8.4" textAnchor="middle" fontSize="6.5" fill="var(--act-question)" fontFamily="inherit">
        ?
      </text>
    </svg>
  );
}

function CheckGlyph({ colorVar }: { colorVar: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path d="M2 6.2L4.8 9L10 3.2" stroke={colorVar} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ACT_LABEL: Record<string, string> = {
  propose: "proposal",
  question: "question",
  objection: "objection",
  agree: "agreement",
  done: "done",
};

function Pill({ children }: { children: ReactNode }) {
  return (
    <span aria-live="polite" className="desk-pill-crossfade shrink-0 inline-flex items-center gap-1.5">
      {children}
    </span>
  );
}

function NeutralPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">{children}</span>
  );
}

/**
 * The desk card — all seven Design.md §3.6 treatments. Props are the STABLE contract shared across
 * TKT-12…15: do not add/remove props. Motion is CSS-only (globals.css `.desk-*` keyframes), with
 * `prefers-reduced-motion` fallbacks defined alongside them.
 */
export function Desk({ role, state, badgeAct, preview, progress, onRetry }: DeskProps) {
  const roleVar = ROLE_VAR[role];
  const artifactType = artifactOf(role);
  const headings = HEADINGS[artifactType];
  const done = progress?.done ?? 0;

  const borderClass =
    state === "idle"
      ? `border-l-4 ${ROLE_BORDER_40[role]}`
      : state === "failed"
        ? "border-l-4 border-act-objection"
        : `border-l-4 ${ROLE_BORDER[role]}`;

  const cardStyle: CSSProperties = {
    ...(state === "speaking" ? { boxShadow: "var(--shadow-md)" } : undefined),
    ...(state === "failed" ? { backgroundColor: "color-mix(in oklch, var(--act-objection) 6%, var(--surface))" } : undefined),
  };

  return (
    <div
      data-testid={`desk-${role}`}
      data-role={role}
      data-state={state}
      role={state === "failed" ? "alert" : undefined}
      className={`relative flex items-center gap-3 rounded-lg bg-surface p-4 ${borderClass}`}
      style={cardStyle}
    >
      {state === "waiting" && (
        <span
          aria-hidden
          className="desk-waiting-ring pointer-events-none absolute inset-0 rounded-lg"
          style={{ boxShadow: `inset 0 0 0 2px var(--amber-500)`, border: "2px dashed var(--amber-500)" }}
        />
      )}

      <span className="relative shrink-0" style={{ opacity: state === "idle" ? 0.6 : 1 }}>
        {state === "thinking" && (
          <span
            aria-hidden
            className="desk-thinking-glow absolute -inset-2 rounded-full"
            style={{ backgroundColor: roleVar, filter: "blur(6px)" }}
          />
        )}
        <span className={`relative ${ROLE_TEXT[role]}`}>
          <RoleGlyph role={role} />
        </span>
      </span>

      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold ${ROLE_TEXT[role]}`}>{ROLE_NAME[role]}</div>

        {state === "speaking" && preview !== undefined && (
          <div className="mt-1 truncate text-xs text-text-muted">
            <Typewriter key={preview} text={preview} colorVar={roleVar} />
          </div>
        )}

        {state === "writing" && (
          <ul className="mt-2 flex flex-col gap-1">
            {headings.map((heading, i) => {
              const isDone = i < done;
              return (
                <li key={heading} className="flex items-center gap-1.5 text-xs text-text-muted">
                  <span
                    className={isDone ? "desk-heading-tick-in" : ""}
                    style={{
                      display: "inline-flex",
                      width: "10px",
                      height: "10px",
                      borderRadius: "9999px",
                      border: `1px solid ${isDone ? roleVar : "var(--border)"}`,
                      backgroundColor: isDone ? roleVar : "transparent",
                    }}
                    aria-hidden
                  />
                  <span className={isDone ? ROLE_TEXT[role] : ""}>{heading}</span>
                </li>
              );
            })}
          </ul>
        )}

      </div>

      {state === "idle" && <Pill><NeutralPill>Ready</NeutralPill></Pill>}

      {state === "thinking" && (
        <Pill>
          <NeutralPill>
            <span className="inline-flex items-center gap-1.5">
              <Spinner colorVar={roleVar} />
              Thinking…
            </span>
          </NeutralPill>
        </Pill>
      )}

      {state === "speaking" && (
        <Pill>
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ backgroundColor: roleVar, color: role === "designer" ? "var(--neutral-950)" : "var(--neutral-0)" }}
          >
            Speaking
          </span>
        </Pill>
      )}

      {state === "waiting" && (
        <Pill>
          <NeutralPill>
            <span className="inline-flex items-center gap-1.5">
              {badgeAct && (
                <>
                  <ActIcon act={badgeAct} />
                  <span className="sr-only">{ACT_LABEL[badgeAct]}</span>
                </>
              )}
              Waiting on reply
            </span>
          </NeutralPill>
        </Pill>
      )}

      {state === "writing" && progress && (
        <Pill>
          <NeutralPill>
            Writing draft… {progress.done}/{progress.total} sections
          </NeutralPill>
        </Pill>
      )}

      {state === "done" && (
        <Pill>
          <span className="desk-done-settle inline-flex items-center gap-1.5 rounded-full border border-l-4 px-2.5 py-1 text-xs text-text-muted" style={{ borderColor: "var(--border)", borderLeftColor: "var(--state-success)" }}>
            <CheckGlyph colorVar="var(--state-success)" />
            <span className="sr-only">done</span>
            Done
          </span>
        </Pill>
      )}

      {state === "failed" && (
        <Pill>
          {onRetry ? (
            <span className="inline-flex items-center gap-2">
              <NeutralPill>Could not finish</NeutralPill>
              <button
                type="button"
                onClick={onRetry}
                className="press flex h-11 min-w-11 items-center justify-center rounded-md border border-act-objection px-3 text-xs font-semibold text-act-objection"
              >
                Retry
              </button>
            </span>
          ) : (
            <NeutralPill>Something went wrong</NeutralPill>
          )}
        </Pill>
      )}
    </div>
  );
}
