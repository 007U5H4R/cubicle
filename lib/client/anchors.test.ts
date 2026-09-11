import { afterEach, describe, expect, it } from "vitest";
import { edgePoint, getAnchor, panelAnchor, registerAnchor } from "./anchors";

function rect(overrides: Partial<DOMRect> = {}): DOMRect {
  return {
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 100,
    bottom: 100,
    width: 100,
    height: 100,
    toJSON() {
      return this;
    },
    ...overrides,
  } as DOMRect;
}

afterEach(() => {
  document.body.innerHTML = "";
  registerAnchor("pm", null);
  registerAnchor("researcher", null);
  registerAnchor("designer", null);
  registerAnchor("developer", null);
});

describe("getAnchor", () => {
  it("returns null when no matching element is mounted", () => {
    expect(getAnchor("pm")).toBeNull();
  });

  it("queries [data-role] by default", () => {
    const el = document.createElement("div");
    el.setAttribute("data-role", "pm");
    el.getBoundingClientRect = () => rect({ left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 });
    document.body.appendChild(el);

    const r = getAnchor("pm");
    expect(r).not.toBeNull();
    expect(r!.left).toBe(10);
  });

  it("prefers a registered element over the DOM query", () => {
    const queried = document.createElement("div");
    queried.setAttribute("data-role", "pm");
    queried.getBoundingClientRect = () => rect({ left: 0 });
    document.body.appendChild(queried);

    const registered = document.createElement("div");
    registered.getBoundingClientRect = () => rect({ left: 999 });
    registerAnchor("pm", registered);

    expect(getAnchor("pm")!.left).toBe(999);
  });

  it("falls back to the DOM query once a registration is cleared", () => {
    const registered = document.createElement("div");
    registered.getBoundingClientRect = () => rect({ left: 999 });
    registerAnchor("pm", registered);
    registerAnchor("pm", null);

    const queried = document.createElement("div");
    queried.setAttribute("data-role", "pm");
    queried.getBoundingClientRect = () => rect({ left: 42 });
    document.body.appendChild(queried);

    expect(getAnchor("pm")!.left).toBe(42);
  });

  it("returns null under SSR (no document)", () => {
    const original = globalThis.document;
    // @ts-expect-error simulate SSR
    delete globalThis.document;
    try {
      expect(getAnchor("pm")).toBeNull();
    } finally {
      globalThis.document = original;
    }
  });
});

describe("panelAnchor", () => {
  it("returns null when the transcript panel isn't mounted", () => {
    expect(panelAnchor()).toBeNull();
  });

  it("queries [data-testid=transcript-panel]", () => {
    const el = document.createElement("div");
    el.setAttribute("data-testid", "transcript-panel");
    el.getBoundingClientRect = () => rect({ left: 5 });
    document.body.appendChild(el);
    expect(panelAnchor()!.left).toBe(5);
  });
});

describe("edgePoint", () => {
  const square = rect({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 });

  it("returns the boundary point facing directly right", () => {
    expect(edgePoint(square, { x: 1000, y: 50 })).toEqual({ x: 100, y: 50 });
  });

  it("returns the boundary point facing directly left", () => {
    expect(edgePoint(square, { x: -1000, y: 50 })).toEqual({ x: 0, y: 50 });
  });

  it("returns the boundary point facing directly up", () => {
    expect(edgePoint(square, { x: 50, y: -1000 })).toEqual({ x: 50, y: 0 });
  });

  it("returns the boundary point facing directly down", () => {
    expect(edgePoint(square, { x: 50, y: 1000 })).toEqual({ x: 50, y: 100 });
  });

  it("returns the center when the target coincides with the center", () => {
    expect(edgePoint(square, { x: 50, y: 50 })).toEqual({ x: 50, y: 50 });
  });

  it("clips diagonally toward a corner-ish target without leaving the rect", () => {
    const p = edgePoint(square, { x: 200, y: 150 });
    expect(p.x).toBeLessThanOrEqual(100);
    expect(p.y).toBeLessThanOrEqual(100);
    // On the boundary: either x or y sits at the rect's edge.
    expect(p.x === 100 || p.y === 100).toBe(true);
  });
});
