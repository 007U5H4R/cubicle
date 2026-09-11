import { describe, expect, it } from "vitest";
import { bezierPoint, controlPoint, travelDuration } from "./travelPath";

describe("travelDuration", () => {
  it("clamps to the 480ms floor for zero/short distance", () => {
    expect(travelDuration(0)).toBe(480);
    expect(travelDuration(10)).toBe(480 + 10 * 0.35);
  });

  it("scales linearly with distance between the floor and ceiling", () => {
    expect(travelDuration(200)).toBeCloseTo(480 + 200 * 0.35);
    expect(travelDuration(500)).toBeCloseTo(480 + 500 * 0.35);
  });

  it("clamps to the 820ms ceiling for large (diagonal) distances", () => {
    expect(travelDuration(2000)).toBe(820);
    expect(travelDuration(10000)).toBe(820);
  });
});

describe("controlPoint", () => {
  it("offsets by 15% of the straight-line distance from the midpoint", () => {
    const from = { x: 0, y: 100 };
    const to = { x: 100, y: 100 };
    const ctrl = controlPoint(from, to);
    const mx = 50;
    const my = 100;
    const offset = Math.hypot(ctrl.x - mx, ctrl.y - my);
    expect(offset).toBeCloseTo(100 * 0.15);
  });

  it("arcs 'up' (negative screen-y bias) regardless of line direction", () => {
    const ab = controlPoint({ x: 0, y: 100 }, { x: 100, y: 100 });
    expect(ab.y).toBeLessThan(100);

    // Reversed direction should still bias the same way, not flip to arcing down.
    const ba = controlPoint({ x: 100, y: 100 }, { x: 0, y: 100 });
    expect(ba.y).toBeLessThan(100);
  });

  it("is perpendicular to the from-to line", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 0 };
    const ctrl = controlPoint(from, to);
    // For a horizontal line the perpendicular offset is purely vertical.
    expect(ctrl.x).toBeCloseTo(50);
  });

  it("returns the midpoint for coincident points", () => {
    expect(controlPoint({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe("bezierPoint", () => {
  const from = { x: 0, y: 0 };
  const ctrl = { x: 50, y: -20 };
  const to = { x: 100, y: 0 };

  it("t=0 is the start point", () => {
    expect(bezierPoint(0, from, ctrl, to)).toEqual(from);
  });

  it("t=1 is the end point", () => {
    expect(bezierPoint(1, from, ctrl, to)).toEqual(to);
  });

  it("t=0.5 is pulled toward the control point (arcs off the straight line)", () => {
    const mid = bezierPoint(0.5, from, ctrl, to);
    expect(mid.x).toBeCloseTo(50);
    expect(mid.y).toBeLessThan(0); // pulled up, off the straight from-to line (y=0)
  });
});
