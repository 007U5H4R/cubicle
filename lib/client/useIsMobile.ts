import { useSyncExternalStore } from "react";

// TKT-16 — SSR-safe mobile breakpoint hook, mirroring the `useSyncExternalStore` mount-gate pattern
// MessageTravel already uses for "are we on the client" (no React state + effect pair needed for a
// value React itself doesn't own). Threshold matches the existing `md:` Tailwind breakpoint (768px):
// mobile is `(max-width: 767px)`. SSR/initial snapshot is `false` (desktop-first) so hydration never
// mismatches; the real value reconciles on mount once `matchMedia` is available.

const QUERY = "(max-width: 767px)";

function subscribe(callback: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => {};
  }
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/** True when the viewport is narrower than the `md:` breakpoint (767px and below). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
