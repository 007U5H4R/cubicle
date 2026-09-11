import type { ReactElement } from "react";
import { motion } from "framer-motion";

/**
 * The act chip: a small `--radius-full` pill carrying the five conversational acts (Design.md §3.7).
 * Never color alone — every act is distinguishable by hue + icon + label glyph (a11y, color-blind
 * safe): objection vs agree differ in hue (27° vs 148°), chroma, icon (triangle-exclamation vs
 * check), and label (OBJ vs AGR). `layoutId` is optional so Dispatch B's MessageTravel can hand a
 * flying chip off to the transcript row via framer's shared layout animation; when unset this
 * renders a plain `<span>` so the leaf has no framer runtime cost in static contexts.
 */
export type Act = "propose" | "question" | "objection" | "agree" | "done";

export interface ActChipProps {
  act: Act;
  /** sm = 20px tall (transcript row), md = 28px tall (travel). Default "md". */
  size?: "sm" | "md";
  /** When set, renders as `<motion.span layoutId>` for shared-layout hand-off. */
  layoutId?: string;
  /** Reserved for reduced-motion; no animation lives in the chip itself yet. */
  reduced?: boolean;
  className?: string;
}

const ACT_GLYPH: Record<Act, string> = {
  propose: "PRO",
  question: "Q",
  objection: "OBJ",
  agree: "AGR",
  done: "DONE",
};

const ACT_WORD: Record<Act, string> = {
  propose: "proposal",
  question: "question",
  objection: "objection",
  agree: "agreement",
  done: "done",
};

const ACT_BG: Record<Act, string> = {
  propose: "bg-act-propose",
  question: "bg-act-question",
  objection: "bg-act-objection",
  agree: "bg-act-agree",
  done: "bg-act-done",
};

/** White vs dark foreground per act's OKLCH lightness (mirrors Desk's `role === "designer"` precedent
 * for the light amber fill): propose/objection/done are darker fills → neutral-0; question/agree are
 * lighter fills → neutral-950. */
const ACT_FG: Record<Act, string> = {
  propose: "var(--neutral-0)",
  question: "var(--neutral-950)",
  objection: "var(--neutral-0)",
  agree: "var(--neutral-950)",
  done: "var(--neutral-0)",
};

function ProposeIcon({ colorVar }: { colorVar: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="3.4" fill={colorVar} />
    </svg>
  );
}

function QuestionIcon({ colorVar }: { colorVar: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <circle cx="5" cy="5" r="4.2" stroke={colorVar} strokeWidth="1.1" />
      <text x="5" y="7" textAnchor="middle" fontSize="5.5" fill={colorVar} fontFamily="inherit">
        ?
      </text>
    </svg>
  );
}

function ObjectionIcon({ colorVar }: { colorVar: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M5 1L9.3 8.6H0.7L5 1Z" stroke={colorVar} strokeWidth="1.1" strokeLinejoin="round" />
      <line x1="5" y1="3.8" x2="5" y2="5.8" stroke={colorVar} strokeWidth="1.1" strokeLinecap="round" />
      <circle cx="5" cy="7.1" r="0.55" fill={colorVar} />
    </svg>
  );
}

function CheckIcon({ colorVar }: { colorVar: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <path d="M1.6 5.2L4 7.6L8.3 2.6" stroke={colorVar} strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Distinct from CheckIcon (agree) — a filled terminal/stop mark, so "done" doesn't rely on hue alone
 * to read differently from "agree" at a glance. */
function DoneIcon({ colorVar }: { colorVar: string }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
      <rect x="2" y="2" width="6" height="6" rx="1" fill={colorVar} />
    </svg>
  );
}

const ACT_ICON: Record<Act, (props: { colorVar: string }) => ReactElement> = {
  propose: ProposeIcon,
  question: QuestionIcon,
  objection: ObjectionIcon,
  agree: CheckIcon,
  done: DoneIcon,
};

export function ActChip({ act, size = "md", layoutId, className }: ActChipProps) {
  const heightClass = size === "sm" ? "h-5" : "h-7";
  const colorVar = ACT_FG[act];
  const Icon = ACT_ICON[act];

  const classes = `inline-flex items-center gap-1 rounded-full ${heightClass} px-2 font-plex-mono text-[10px] font-semibold tracking-wide ${ACT_BG[act]} ${className ?? ""}`;
  const style = { color: colorVar };

  const content = (
    <>
      <Icon colorVar={colorVar} />
      <span aria-hidden>{ACT_GLYPH[act]}</span>
      <span className="sr-only">{ACT_WORD[act]}</span>
    </>
  );

  if (layoutId) {
    return (
      <motion.span data-act={act} layoutId={layoutId} className={classes} style={style}>
        {content}
      </motion.span>
    );
  }

  return (
    <span data-act={act} className={classes} style={style}>
      {content}
    </span>
  );
}
