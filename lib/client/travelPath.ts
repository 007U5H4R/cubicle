import type { Point } from "./anchors";

// TKT-13 Dispatch B (TSK-13.2b) — the pure travel-arc geometry (Design.md §3.7/§4). Extracted from
// MessageTravel so it's testable without jsdom layout or framer's layout-animation runtime, per the
// brief: jsdom can't measure real layout or run framer shared-layout transitions.

/** `clamp(480, 480 + distance * 0.35, 820)` ms (Design.md §4) — diagonally-opposite desks (larger
 * `distance`) travel longer, adjacent desks travel near the floor. */
export function travelDuration(distance: number): number {
  return Math.min(820, Math.max(480, 480 + distance * 0.35));
}

/** The quadratic-bezier control point: the line's midpoint, offset perpendicular to the line by 15%
 * of the straight-line distance, biased to arc "up" (negative screen-y) so the path reads as a
 * hand-off rather than a slide (Design.md §3.7/§4). */
export function controlPoint(from: Point, to: Point): Point {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: mx, y: my };

  // Unit perpendicular to the from→to line; flip so the offset always biases toward negative y
  // ("up" on screen) regardless of the line's direction.
  let px = -dy / distance;
  let py = dx / distance;
  if (py > 0) {
    px = -px;
    py = -py;
  }

  const offset = distance * 0.15;
  return { x: mx + px * offset, y: my + py * offset };
}

/** Point at parameter `t` (0..1) along the quadratic bezier `from` → `ctrl` → `to`. */
export function bezierPoint(t: number, from: Point, ctrl: Point, to: Point): Point {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y,
  };
}
