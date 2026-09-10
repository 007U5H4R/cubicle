"use client";
import type { KeyboardEvent } from "react";

export const IDEA_MAX_LEN = 500;

export type IdeaBoxError =
  | { kind: "limit"; message: string }
  | { kind: "server"; message: string }
  | { kind: "validation"; message: string };

export interface IdeaBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  error?: IdeaBoxError | null;
}

function isSubmittable(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= IDEA_MAX_LEN;
}

/** The `/` idea box: prompt, textarea, Start button, always-visible provider notice, inline errors. */
export function IdeaBox({ value, onChange, onSubmit, disabled, error }: IdeaBoxProps) {
  const submittable = !disabled && isSubmittable(value);

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (submittable) onSubmit();
    }
    // Shift+Enter: no preventDefault — the textarea inserts a newline itself.
  }

  return (
    <div
      className="rounded-lg border border-border bg-surface p-4"
      style={{
        paddingLeft: "max(var(--space-4), env(safe-area-inset-left))",
        paddingRight: "max(var(--space-4), env(safe-area-inset-right))",
      }}
    >
      <label htmlFor="idea" className="mb-3 block text-2xl font-bold text-text">
        What are you building?
      </label>
      <textarea
        id="idea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder="e.g. a subscription tracker for families"
        rows={3}
        className="min-h-[44px] w-full resize-y rounded-md border border-border bg-bg p-3 text-base text-text placeholder:text-text-muted disabled:opacity-60"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <p className="text-xs text-text-muted">Sent to Google&apos;s Gemini to run your office.</p>
        <button
          type="button"
          onClick={() => submittable && onSubmit()}
          disabled={!submittable}
          aria-label="Start"
          className="flex h-11 min-w-11 items-center justify-center rounded-md bg-brand-500 px-4 text-sm font-semibold text-white transition-transform duration-[90ms] ease-[var(--ease-out-expo)] active:scale-[0.97] disabled:opacity-50"
        >
          ▶
        </button>
      </div>
      {error && (
        <div role="alert" className="mt-3 rounded-md border border-border bg-bg p-3 text-sm text-text">
          {error.kind === "limit" ? (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span>You&apos;ve used your free run — sign in to run more.</span>
              {/* Placeholder — real sign-in is TKT-18 */}
              <button
                type="button"
                disabled
                className="h-11 shrink-0 rounded-md border border-border px-3 text-sm text-text-muted"
              >
                Sign in
              </button>
            </div>
          ) : (
            <span>{error.message}</span>
          )}
        </div>
      )}
    </div>
  );
}
