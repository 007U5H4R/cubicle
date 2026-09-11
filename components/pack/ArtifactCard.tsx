"use client";
import { useState } from "react";
import { Markdown } from "./Markdown";
import { useRunStore } from "@/lib/client/runStore";
import { ARTIFACT_ROLE, type ArtifactType } from "@/lib/prompts/headings";
import type { Role } from "@/lib/engine/envelope";

// TKT-14 Dispatch B — one pack card. Design.md §3.9: `--radius-lg`, `--shadow-sm`, a header bar in
// the owning role's color, a copy-artifact icon button top-right. §10 fixes the exact title per
// type. The `grounded=false` unverified line (§13 "Scan opens with 'From memory, unverified'") is
// NOT re-rendered here — `lib/engine/deliver.ts`'s `UNVERIFIED_PREFIX` is already prepended into
// `content_md` server-side before any text streams (see deliverOne's `streamAttempt` seeding `full`
// with `prefix`), so it is already the first line of the markdown body. Re-adding it here would
// duplicate it.

const TITLE: Record<ArtifactType, string> = {
  prd: "PRD",
  scan: "Competitor scan",
  copy: "Landing copy",
  plan: "Build plan",
};

const ROLE_BG: Record<Role, string> = {
  pm: "bg-role-pm",
  researcher: "bg-role-researcher",
  designer: "bg-role-designer",
  developer: "bg-role-developer",
};

/** Amber (designer) is the only role fill light enough to need dark header text — mirrors Desk.tsx's
 * `role === "designer" ? "var(--neutral-950)" : "var(--neutral-0)"` precedent. */
const ROLE_HEADER_TEXT: Record<Role, string> = {
  pm: "text-neutral-0",
  researcher: "text-neutral-0",
  designer: "text-neutral-950",
  developer: "text-neutral-0",
};

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <rect x="4.5" y="4.5" width="8" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.5 9.5V2.5C2.5 1.94772 2.94772 1.5 3.5 1.5H9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function sourceHref(source: unknown): string | null {
  if (typeof source === "string") return source;
  if (source && typeof source === "object") {
    const obj = source as Record<string, unknown>;
    const url = obj.url ?? obj.href ?? obj.link;
    if (typeof url === "string") return url;
  }
  return null;
}

function sourceLabel(source: unknown, href: string): string {
  if (source && typeof source === "object") {
    const obj = source as Record<string, unknown>;
    if (typeof obj.title === "string") return obj.title;
    if (typeof obj.name === "string") return obj.name;
  }
  return href;
}

export interface ArtifactCardProps {
  type: ArtifactType;
}

export function ArtifactCard({ type }: ArtifactCardProps) {
  const snap = useRunStore();
  const artifact = snap.artifacts[type];
  const role = ARTIFACT_ROLE[type];
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      if (!navigator.clipboard) return;
      await navigator.clipboard.writeText(artifact.content_md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable/denied — no-op, the button simply doesn't confirm.
    }
  }

  const sources = artifact.sources.filter((s) => sourceHref(s) !== null);

  return (
    <div
      data-testid={`artifact-card-${type}`}
      className="overflow-hidden rounded-[var(--radius-lg)] bg-surface"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className={`flex items-center justify-between gap-3 px-4 py-3 ${ROLE_BG[role]} ${ROLE_HEADER_TEXT[role]}`}>
        <h3 className="text-sm font-semibold">{TITLE[type]}</h3>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={`Copy ${TITLE[type]}`}
          title={copied ? "Copied" : "Copy"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-opacity hover:opacity-80"
        >
          <CopyIcon />
        </button>
      </div>

      {copied && (
        <div role="status" className="px-4 pt-2 text-xs text-text-muted">
          Copied
        </div>
      )}

      <div className="px-4 pb-4">
        <Markdown>{artifact.content_md}</Markdown>

        {artifact.status === "done" && sources.length > 0 && (
          <div className="mt-3 border-t border-border pt-2">
            <p className="text-xs font-semibold text-text-muted">Sources</p>
            <ul className="mt-1 flex flex-col gap-1">
              {sources.map((source, i) => {
                const href = sourceHref(source)!;
                return (
                  <li key={i} className="truncate text-xs">
                    <a href={href} rel="noopener noreferrer" target="_blank" className="text-brand-500 underline underline-offset-2">
                      {sourceLabel(source, href)}
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
