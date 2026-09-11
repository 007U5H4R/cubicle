"use client";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { ActChip } from "./ActChip";
import { edgePoint, getAnchor, panelAnchor, type Point } from "@/lib/client/anchors";
import { bezierPoint, controlPoint, travelDuration } from "@/lib/client/travelPath";
import { useRunStore } from "@/lib/client/runStore";
import type { Envelope } from "@/lib/engine/envelope";

/**
 * TKT-13 Dispatch B (TSK-13.2b) — the desk-to-desk message travel layer (Design.md §3.7/§4). A
 * fixed, `pointer-events-none` portal that, for every newly-appended message, animates an act chip
 * from the sender's desk edge to the addressee's desk edge (or the transcript panel, for `to_role:
 * "team"`) along a quadratic bezier, then hands off to the transcript row.
 *
 * Handoff mechanism (TC-052, load-bearing): the flying chip and the transcript row's chip both carry
 * `layoutId={`chip-${id}`}` (TranscriptPanel/Dispatch A already sets this on the row chip) as the
 * shared identity, per the brief. But the row chip mounts the instant the message lands in the store
 * — the same render pass that starts this flight — so relying on framer's cross-portal shared-layout
 * projection alone would show both the flying chip and an already-visible row chip for the whole
 * flight, not just a brief flash. Instead we use the brief's documented fallback: on enqueue we
 * directly set the row chip's `opacity` to 0 (it's the *same* DOM node the row already rendered —
 * TranscriptPanel's contract/props are untouched, this only reaches into its rendered output via the
 * stable `data-message-id`/`data-act` attributes Dispatch A exposes); on arrival we clear that
 * override with an 80ms fade back in exactly as the flying chip is removed. One chip visible at any
 * time, no duplicate flash — deterministic, since it's the literal same node rather than a second
 * framer-tracked element.
 */

export interface MessageTravelProps {
  /** true → no arc: chip fades in directly at the row position (the row's own entrance already does
   * this), objection shake becomes a single flash. Default false (TKT-17 wires the real hook). */
  reduced?: boolean;
}

interface FlightSpec {
  id: string;
  act: Envelope["act"];
  from: Point;
  to: Point;
  ctrl: Point;
  duration: number;
  toRole: Envelope["to_role"];
}

const SHAKE_MS = 350;
const FLASH_MS = 200;
const ROW_CHIP_SELECTOR = (id: string) => `[data-message-id="${id}"] [data-act]`;

// Client-mount gate for the portal, via useSyncExternalStore rather than a `useState` + `useEffect`
// pair: no subscription is needed (the value never changes after mount), so this is the
// react-hooks-sanctioned way to read "are we on the client, post-hydration" without a
// setState-in-effect render pass — same primitive this codebase's own run store is built on.
function subscribeNever() {
  return () => {};
}
function trueSnapshot() {
  return true;
}
function falseSnapshot() {
  return false;
}

function hideRowChip(id: string): void {
  const el = document.querySelector<HTMLElement>(ROW_CHIP_SELECTOR(id));
  if (el) el.style.opacity = "0";
}

function revealRowChip(id: string): void {
  const el = document.querySelector<HTMLElement>(ROW_CHIP_SELECTOR(id));
  if (!el) return;
  el.style.transition = "opacity 80ms ease-out";
  el.style.opacity = "";
  window.setTimeout(() => {
    el.style.transition = "";
  }, 100);
}

function triggerObjectionFeedback(role: string, reduced: boolean): void {
  const el = document.querySelector<HTMLElement>(`[data-role="${role}"]`);
  if (!el) return;
  const cls = reduced ? "desk-objection-flash" : "desk-objection-shake";
  const ms = reduced ? FLASH_MS : SHAKE_MS;
  el.classList.remove(cls);
  void el.offsetWidth; // force reflow so a re-triggered class restarts the animation
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

function Flight({ spec, onArrive }: { spec: FlightSpec; onArrive: () => void }) {
  const progress = useMotionValue(0);
  const x = useTransform(progress, (p) => bezierPoint(p, spec.from, spec.ctrl, spec.to).x);
  const y = useTransform(progress, (p) => bezierPoint(p, spec.from, spec.ctrl, spec.to).y);

  useEffect(() => {
    // springMessage's feel (Design.md §4: stiffness 140, damping 20, mass 1) with an explicit
    // duration: TC-052 requires the 480-820ms distance-scaled duration exactly, and framer-motion's
    // spring-by-duration form (duration + bounce) is the supported way to get spring motion under an
    // exact duration rather than one implied by stiffness/damping/mass.
    const controls = animate(progress, 1, {
      type: "spring",
      duration: spec.duration / 1000,
      bounce: 0.15,
      onComplete: onArrive,
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- spec/onArrive are stable per flight instance (keyed by id)
  }, []);

  return (
    <motion.div style={{ position: "fixed", left: 0, top: 0, x, y, zIndex: 60 }}>
      <div className="-translate-x-1/2 -translate-y-1/2">
        <ActChip act={spec.act} size="md" layoutId={`chip-${spec.id}`} />
      </div>
    </motion.div>
  );
}

export function MessageTravel({ reduced = false }: MessageTravelProps) {
  const snap = useRunStore();
  const mounted = useSyncExternalStore(subscribeNever, trueSnapshot, falseSnapshot);
  const [flights, setFlights] = useState<FlightSpec[]>([]);
  const flownRef = useRef<Set<string>>(new Set());
  const seededRef = useRef(false);
  const prevRunIdRef = useRef<string | null>(null);
  const prevLenRef = useRef(0);

  useLayoutEffect(() => {
    // Two reset signals restart travel tracking so the same message ids can fly again: the run
    // identity changing (a genuinely new run), and the message list shrinking (the `/dev/office`
    // fixture stepper's Reset button calls the store's `reset()`, which clears `messages` back to
    // `[]` without ever changing `runId` from null — the length-shrink check is what makes Reset
    // re-demo travel instead of silently no-opping on already-flown ids).
    const isReset = snap.runId !== prevRunIdRef.current || snap.messages.length < prevLenRef.current;
    prevRunIdRef.current = snap.runId;
    prevLenRef.current = snap.messages.length;
    if (isReset) {
      flownRef.current.clear();
      seededRef.current = false;
      setFlights([]);
    }
  }, [snap.runId, snap.messages.length]);

  useLayoutEffect(() => {
    // Seed with whatever backlog is already present on first run (hydrate/mount) so it never
    // replays travel for messages that existed before this component mounted.
    if (!seededRef.current) {
      seededRef.current = true;
      for (const m of snap.messages) flownRef.current.add(m.id);
      return;
    }

    const newFlights: FlightSpec[] = [];

    for (const m of snap.messages) {
      if (flownRef.current.has(m.id)) continue;
      flownRef.current.add(m.id);
      if (m.from_role === "office") continue; // steer/system frames carry no act, not part of travel

      if (reduced) {
        if (m.act === "objection" && m.to_role !== "team") triggerObjectionFeedback(m.to_role, true);
        continue; // no arc; the row's own 120ms opacity entrance is the whole animation
      }

      const fromRect = getAnchor(m.from_role);
      const toRect = m.to_role === "team" ? panelAnchor() : getAnchor(m.to_role);
      if (!fromRect || !toRect) continue; // no anchor: skip the arc, the row still appears normally

      const fromCenter = { x: fromRect.left + fromRect.width / 2, y: fromRect.top + fromRect.height / 2 };
      const toCenter = { x: toRect.left + toRect.width / 2, y: toRect.top + toRect.height / 2 };
      const from = edgePoint(fromRect, toCenter);
      const to = edgePoint(toRect, fromCenter);
      const ctrl = controlPoint(from, to);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);

      hideRowChip(m.id);
      newFlights.push({ id: m.id, act: m.act, from, to, ctrl, duration: travelDuration(distance), toRole: m.to_role });
    }

    if (newFlights.length > 0) {
      // enqueueing a flight requires DOM anchor measurement (getAnchor/panelAnchor), which only
      // exists post-commit; this is the "subscribe to an external system (the run store) and
      // setState when it changes" case the rule exempts, batched into one update per commit rather
      // than one per message.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFlights((prev) => [...prev, ...newFlights]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reduced` is read fresh each run; snap.messages is the real trigger
  }, [snap.messages]);

  function handleArrive(spec: FlightSpec) {
    setFlights((prev) => prev.filter((f) => f.id !== spec.id));
    revealRowChip(spec.id);
    if (spec.act === "objection" && spec.toRole !== "team") {
      triggerObjectionFeedback(spec.toRole, false);
    }
  }

  if (!mounted || flights.length === 0) return null;

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0" style={{ zIndex: 60 }}>
      {flights.map((spec) => (
        <Flight key={spec.id} spec={spec} onArrive={() => handleArrive(spec)} />
      ))}
    </div>,
    document.body,
  );
}
