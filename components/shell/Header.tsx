import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "./LogoMark";

export function Header({ status, auth }: { status?: ReactNode; auth?: ReactNode }) {
  return (
    <header
      className="sticky top-0 z-40 flex h-[52px] items-center gap-3 border-b bg-[var(--surface)] px-[var(--gutter)] md:h-[56px]"
      style={{ borderColor: "var(--border)" }}
    >
      <Link
        href="/"
        className="display flex items-center gap-2 text-[var(--text-lg)] font-bold"
        aria-label="Cubicle home"
      >
        <LogoMark />
        <span>Cubicle</span>
      </Link>
      <div className="min-w-0 flex-1 truncate">{status}</div>
      <div className="flex items-center">
        {auth ?? (
          <button
            type="button"
            className="flex h-11 min-w-11 items-center justify-center rounded-[var(--radius-md)] px-3 text-[var(--text-sm)] text-[var(--text-muted)] hover:bg-[var(--surface-raised)] md:h-auto md:px-4 md:py-2"
            aria-label="Sign in"
          >
            <span className="hidden md:inline">Sign in</span>
            <span className="md:hidden" aria-hidden>
              ◯
            </span>
          </button>
        )}
      </div>
    </header>
  );
}
