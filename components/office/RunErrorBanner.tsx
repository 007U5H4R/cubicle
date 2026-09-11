/**
 * TKT-15 — run-level error banner (Design.md §3.9 / Solution-PRD.md §13). Shown in addition to the
 * existing per-desk `failed` treatments when the whole run terminated in failure. Kept to a single
 * honest line, not a full-screen takeover.
 */
export function RunErrorBanner() {
  return (
    <div
      role="alert"
      className="rounded-lg border border-act-objection bg-surface p-3 text-sm text-act-objection"
      style={{ backgroundColor: "color-mix(in oklch, var(--act-objection) 6%, var(--surface))" }}
    >
      Something went wrong with this run.
    </div>
  );
}
