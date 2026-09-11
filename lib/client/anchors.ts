import type { Role } from "@/lib/engine/envelope";

// TKT-13 Dispatch B (TSK-13.2a) — a tiny anchor registry so MessageTravel can find desk/panel
// positions in viewport coordinates without Desk/TranscriptPanel exposing any new props. Default
// lookup is a DOM query against the stable `data-role`/`data-testid` attributes Dispatch A/TKT-11
// already render; `registerAnchor` is an optional explicit-registration override (named in the
// technical plan) that takes precedence when set, for callers that want to avoid a re-query.

export interface Point {
  x: number;
  y: number;
}

const registry = new Map<Role, HTMLElement>();

/** Optional explicit-registration override. Pass `null` to clear a role's registration and fall
 * back to the DOM query. */
export function registerAnchor(role: Role, el: HTMLElement | null): void {
  if (el) registry.set(role, el);
  else registry.delete(role);
}

/** A desk's current viewport rect — the registered element if present, else `[data-role="{role}"]`
 * (Desk's existing, stable attribute — TKT-11). Null under SSR (no `document`) or if the desk isn't
 * mounted yet. */
export function getAnchor(role: Role): DOMRect | null {
  if (typeof document === "undefined") return null;
  const registered = registry.get(role);
  if (registered) return registered.getBoundingClientRect();
  return document.querySelector(`[data-role="${role}"]`)?.getBoundingClientRect() ?? null;
}

/** The transcript panel's rect — where `to_role: "team"` messages fan toward, and where every chip
 * ultimately lands. Null under SSR or if the panel isn't mounted. */
export function panelAnchor(): DOMRect | null {
  if (typeof document === "undefined") return null;
  return document.querySelector('[data-testid="transcript-panel"]')?.getBoundingClientRect() ?? null;
}

/**
 * The point on `rect`'s boundary facing `towards` — travel starts/ends at the desk edge closest to
 * the target, not the desk center (Design.md §3.7 "edge-anchor"). Standard center-to-boundary ray
 * intersection: walk from the rect's center toward `towards` and stop at whichever axis (x or y)
 * hits the rect's half-extent first.
 */
export function edgePoint(rect: DOMRect, towards: Point): Point {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const dx = towards.x - cx;
  const dy = towards.y - cy;

  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const scaleX = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const scale = Math.min(scaleX, scaleY);

  return { x: cx + dx * scale, y: cy + dy * scale };
}
