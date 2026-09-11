import { useSyncExternalStore } from "react";

// TKT-17 — SSR-safe `prefers-reduced-motion` hook, mirroring the `useIsMobile.ts` pattern (itself
// mirroring MessageTravel's client-mount gate): `useSyncExternalStore` subscribing to the media
// query rather than a `useState` + `useEffect` pair, since this is a value React doesn't own.
// SSR/initial snapshot is `false` so hydration never mismatches; the real value reconciles on mount
// once `matchMedia` is available.

const QUERY = "(prefers-reduced-motion: reduce)";

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

/** True when the OS/browser `prefers-reduced-motion: reduce` setting is on. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
