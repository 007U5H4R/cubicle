"use client";

import { useEffect, useRef, useState } from "react";
import { contrastRatio } from "@/lib/contrast";

type Pair = {
  id: string;
  label: string;
  /** CSS var for the foreground (text color, or chip fill for non-text pairs) */
  fgVar: string;
  /** CSS var for the background it's checked against */
  bgVar: string;
  threshold: number;
  kind: "text" | "fill";
};

// Design.md §5 "Color & contrast" checklist pairs.
const PAIRS: Pair[] = [
  { id: "text-on-bg", label: "--text on --bg", fgVar: "--text", bgVar: "--bg", threshold: 7, kind: "text" },
  { id: "text-on-surface", label: "--text on --surface", fgVar: "--text", bgVar: "--surface", threshold: 7, kind: "text" },
  { id: "text-muted-on-surface", label: "--text-muted on --surface", fgVar: "--text-muted", bgVar: "--surface", threshold: 4.5, kind: "text" },
  { id: "role-pm-on-surface", label: "--role-pm (text) on --surface", fgVar: "--role-pm", bgVar: "--surface", threshold: 4.5, kind: "text" },
  { id: "role-researcher-on-surface", label: "--role-researcher (text) on --surface", fgVar: "--role-researcher", bgVar: "--surface", threshold: 4.5, kind: "text" },
  { id: "role-designer-on-surface", label: "--role-designer (text) on --surface", fgVar: "--role-designer", bgVar: "--surface", threshold: 4.5, kind: "text" },
  { id: "role-developer-on-surface", label: "--role-developer (text) on --surface", fgVar: "--role-developer", bgVar: "--surface", threshold: 4.5, kind: "text" },
  { id: "act-propose-fill", label: "--act-propose (chip fill) vs --surface", fgVar: "--act-propose", bgVar: "--surface", threshold: 3, kind: "fill" },
  { id: "act-question-fill", label: "--act-question (chip fill) vs --surface", fgVar: "--act-question", bgVar: "--surface", threshold: 3, kind: "fill" },
  { id: "act-objection-fill", label: "--act-objection (chip fill) vs --surface", fgVar: "--act-objection", bgVar: "--surface", threshold: 3, kind: "fill" },
  { id: "act-agree-fill", label: "--act-agree (chip fill) vs --surface", fgVar: "--act-agree", bgVar: "--surface", threshold: 3, kind: "fill" },
  { id: "act-done-fill", label: "--act-done (chip fill) vs --surface", fgVar: "--act-done", bgVar: "--surface", threshold: 3, kind: "fill" },
];

type Result = { id: string; label: string; threshold: number; ratio: number; pass: boolean };

export default function TokensPage() {
  const [dark, setDark] = useState(false);
  const [results, setResults] = useState<Result[]>([]);
  const fgRefs = useRef<Array<HTMLDivElement | null>>([]);
  const bgRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);

  useEffect(() => {
    // Re-measure computed colors after the DOM (and the dark/light attribute) has settled.
    const next = PAIRS.map((pair, i) => {
      const fgEl = fgRefs.current[i];
      const bgEl = bgRefs.current[i];
      if (!fgEl || !bgEl) return null;
      const fgColor =
        pair.kind === "text"
          ? getComputedStyle(fgEl).color
          : getComputedStyle(fgEl).backgroundColor;
      const bgColor = getComputedStyle(bgEl).backgroundColor;
      const ratio = contrastRatio(fgColor, bgColor);
      return { id: pair.id, label: pair.label, threshold: pair.threshold, ratio, pass: ratio >= pair.threshold };
    }).filter((r): r is Result => r !== null);
    setResults(next);
  }, [dark]);

  return (
    <main className="mx-auto max-w-3xl px-[var(--gutter)] py-8">
      <h1 className="text-[var(--text-2xl)]">Token contrast checks</h1>
      <p className="text-[var(--text-sm)] text-[var(--text-muted)]">
        Computed WCAG contrast ratios for the Design.md §5 token pairs, measured via getComputedStyle.
      </p>
      <button
        type="button"
        onClick={() => setDark((d) => !d)}
        className="mt-4 rounded-[var(--radius-md)] border px-3 py-2 text-[var(--text-sm)]"
        style={{ borderColor: "var(--border)" }}
      >
        Toggle dark ({dark ? "dark" : "light"})
      </button>

      {/* Hidden probe elements: computed color/background-color is read off these. */}
      <div aria-hidden style={{ position: "absolute", width: 0, height: 0, overflow: "hidden" }}>
        {PAIRS.map((pair, i) => (
          <div key={pair.id}>
            <div
              ref={(el) => {
                fgRefs.current[i] = el;
              }}
              style={
                pair.kind === "text"
                  ? { color: `var(${pair.fgVar})` }
                  : { backgroundColor: `var(${pair.fgVar})` }
              }
            />
            <div
              ref={(el) => {
                bgRefs.current[i] = el;
              }}
              style={{ backgroundColor: `var(${pair.bgVar})` }}
            />
          </div>
        ))}
      </div>

      <table className="mt-6 w-full border-collapse text-[var(--text-sm)]">
        <thead>
          <tr className="border-b text-left" style={{ borderColor: "var(--border)" }}>
            <th className="py-2 pr-4">Pair</th>
            <th className="py-2 pr-4">Threshold</th>
            <th className="py-2 pr-4">Ratio</th>
            <th className="py-2">Result</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.id} className="border-b" style={{ borderColor: "var(--border)" }}>
              <td className="py-2 pr-4 mono">{r.label}</td>
              <td className="py-2 pr-4">{r.threshold}:1</td>
              <td className="py-2 pr-4 mono">{r.ratio.toFixed(2)}:1</td>
              <td className="py-2" style={{ color: r.pass ? "var(--state-success)" : "var(--state-danger)" }}>
                {r.pass ? "PASS" : "FAIL"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
