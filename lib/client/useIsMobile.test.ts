import { cleanup, renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsMobile } from "./useIsMobile";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: "(max-width: 767px)",
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.delete(cb),
  };
  const matchMedia = vi.fn().mockReturnValue(mql);
  vi.stubGlobal("matchMedia", matchMedia);
  return {
    setMatches(next: boolean) {
      matches = next;
      for (const cb of listeners) cb({ matches: next });
    },
  };
}

describe("useIsMobile", () => {
  it("defaults to false when matchMedia is unavailable (SSR)", () => {
    vi.stubGlobal("matchMedia", undefined);
    // getServerSnapshot path only runs under actual SSR; here we assert the fallback branch of
    // getSnapshot behaves the same way when matchMedia is missing on the client too.
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("reflects matchMedia's initial match state", () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("updates when matchMedia reports a change", () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => media.setMatches(true));
    expect(result.current).toBe(true);
  });
});
