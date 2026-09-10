"use client";
import { useEffect, useRef, useState } from "react";

export interface TypewriterProps {
  text: string;
  reduced?: boolean;
  className?: string;
  /** The role's CSS var (e.g. "var(--role-pm)") used for the caret color. */
  colorVar?: string;
}

const MS_PER_CHAR_MAX = 22;
const TOTAL_CAP_MS = 1400;
const CARET_BLINK_MS = 530;

function prefersReducedMotionNow(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [prefers, setPrefers] = useState(prefersReducedMotionNow);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setPrefers(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return prefers;
}

/**
 * Design.md §4/§3.6 — reveals `text` character-by-character at ~22ms/char, capped at 1.4s total
 * regardless of length (long bodies accelerate — TC-050). A 2px role-colored caret bar blinks by
 * stepping opacity (not a smooth fade) on a 530ms cycle while typing, and hides once complete.
 * `reduced` (prop or OS setting) swaps to a single 150ms fade of the full text, no caret.
 *
 * Callers should key this component by `text` (Desk.tsx does) so a new preview restarts the reveal
 * as a fresh mount rather than resetting state mid-life via an effect.
 */
export function Typewriter({ text, reduced, className, colorVar }: TypewriterProps) {
  const osReduced = usePrefersReducedMotion();
  const isReduced = reduced ?? osReduced;

  const [shown, setShown] = useState(0);
  const [caretOn, setCaretOn] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const caretIntervalRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    if (isReduced) return; // rendered directly below — no per-char reveal, no caret.

    // `shown`/`caretOn` already start at their reveal-beginning values (useState below) — this
    // effect only fires once per mount (callers key Typewriter by `text`), so no reset is needed
    // here; only the interval subscriptions are set up.
    const perChar = Math.min(MS_PER_CHAR_MAX, TOTAL_CAP_MS / Math.max(text.length, 1));

    let i = 0;
    const charInterval = setInterval(() => {
      i += 1;
      setShown(Math.min(i, text.length));
      if (i >= text.length) clearInterval(charInterval);
    }, perChar);
    intervalRef.current = charInterval;

    const caretInterval = setInterval(() => {
      setCaretOn((on) => !on);
    }, CARET_BLINK_MS);
    caretIntervalRef.current = caretInterval;

    return () => {
      clearInterval(charInterval);
      clearInterval(caretInterval);
    };
  }, [text, isReduced]);

  const complete = isReduced || shown >= text.length;

  useEffect(() => {
    if (complete && caretIntervalRef.current) {
      clearInterval(caretIntervalRef.current);
    }
  }, [complete]);

  const displayed = isReduced ? text : text.slice(0, shown);

  return (
    <span className={`${isReduced ? "transition-opacity duration-150 ease-linear" : ""} ${className ?? ""}`}>
      {displayed}
      {!isReduced && !complete && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: "2px",
            height: "1em",
            marginLeft: "1px",
            verticalAlign: "text-bottom",
            backgroundColor: colorVar ?? "currentColor",
            opacity: caretOn ? 1 : 0,
          }}
        />
      )}
    </span>
  );
}
