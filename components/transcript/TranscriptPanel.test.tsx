import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TranscriptPanel, isNearBottom, shouldShowNewPill, relativeTime } from "./TranscriptPanel";
import { applyEvent, reset } from "@/lib/client/runStore";
import type { Envelope } from "@/lib/engine/envelope";

// jsdom never runs layout, so every element reports offsetWidth/offsetHeight 0. @tanstack/react-virtual
// treats a 0-height scroll container as "nothing to render" (its calculateRange short-circuits to an
// empty range when outerSize === 0), which would make every row vanish regardless of the component's
// own logic. Stubbing a fixed viewport size is the standard workaround for testing virtualized lists
// under jsdom — scoped to this file only, restored after.
let restoreOffsetHeight: (() => void) | undefined;
let restoreOffsetWidth: (() => void) | undefined;

beforeAll(() => {
  const heightDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const widthDesc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  restoreOffsetHeight = () => {
    if (heightDesc) Object.defineProperty(HTMLElement.prototype, "offsetHeight", heightDesc);
  };
  restoreOffsetWidth = () => {
    if (widthDesc) Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDesc);
  };
});

afterAll(() => {
  restoreOffsetHeight?.();
  restoreOffsetWidth?.();
});

afterEach(() => {
  cleanup();
  reset();
});

function seedMessage(overrides: Partial<Envelope> & Pick<Envelope, "id" | "seq">) {
  const envelope: Envelope = {
    run_id: "run-test",
    from_role: "pm",
    to: "team",
    to_role: "team",
    act: "propose",
    subject: "Subject",
    body: "Body text",
    reply_to: null,
    hops: 0,
    brief: null,
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
  applyEvent({ run_id: "run-test", seq: envelope.seq, type: "message", payload: envelope });
}

describe("TranscriptPanel — rendering", () => {
  it("renders one row per message, oldest-at-top, with role, chip, body, and timestamp", () => {
    seedMessage({ id: "m1", seq: 1, from_role: "pm", act: "propose", body: "First message body." });
    seedMessage({ id: "m2", seq: 2, from_role: "developer", act: "question", body: "Second message body." });
    seedMessage({ id: "m3", seq: 3, from_role: "designer", act: "objection", body: "Third message body." });

    render(<TranscriptPanel />);

    const rows = screen.getAllByTestId("transcript-row");
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.getAttribute("data-message-id"))).toEqual(["m1", "m2", "m3"]);

    expect(screen.getByText("PM")).toBeInTheDocument();
    expect(screen.getByText("Developer")).toBeInTheDocument();
    expect(screen.getByText("Designer")).toBeInTheDocument();
    expect(screen.getByText("First message body.")).toBeInTheDocument();
    expect(screen.getByText("Second message body.")).toBeInTheDocument();
    expect(screen.getByText("Third message body.")).toBeInTheDocument();
  });

  it("skips from_role: office messages (system/steer rows, no agent turn)", () => {
    seedMessage({ id: "m1", seq: 1, from_role: "pm", act: "propose", body: "Agent turn." });
    seedMessage({
      id: "m2",
      seq: 2,
      from_role: "office" as unknown as Envelope["from_role"],
      act: "propose",
      body: "System steer.",
    });

    render(<TranscriptPanel />);
    expect(screen.getAllByTestId("transcript-row")).toHaveLength(1);
    expect(screen.queryByText("System steer.")).not.toBeInTheDocument();
  });

  it("panel root carries aria-live=polite and aria-atomic=false", () => {
    seedMessage({ id: "m1", seq: 1 });
    render(<TranscriptPanel />);
    const panel = screen.getByTestId("transcript-panel");
    expect(panel).toHaveAttribute("aria-live", "polite");
    expect(panel).toHaveAttribute("aria-atomic", "false");
  });

  it("renders each ActChip with the message's act via the chip-<id> layoutId contract", () => {
    seedMessage({ id: "m1", seq: 1, act: "agree" });
    render(<TranscriptPanel />);
    const chip = screen.getByTestId("transcript-row").querySelector('[data-act="agree"]');
    expect(chip).not.toBeNull();
  });

  it("does not crash with zero messages", () => {
    expect(() => render(<TranscriptPanel />)).not.toThrow();
    expect(screen.queryAllByTestId("transcript-row")).toHaveLength(0);
  });
});

describe("shouldShowNewPill (pure)", () => {
  it("hides when stuck to bottom, regardless of pending count", () => {
    expect(shouldShowNewPill(true, 5)).toBe(false);
    expect(shouldShowNewPill(true, 0)).toBe(false);
  });

  it("hides when not stuck to bottom but nothing pending", () => {
    expect(shouldShowNewPill(false, 0)).toBe(false);
  });

  it("shows when scrolled up and messages have arrived", () => {
    expect(shouldShowNewPill(false, 1)).toBe(true);
    expect(shouldShowNewPill(false, 4)).toBe(true);
  });
});

describe("isNearBottom (pure)", () => {
  it("true when within the default 40px threshold of the bottom", () => {
    // scrollHeight 500, clientHeight 400 -> bottom at scrollTop 100
    expect(isNearBottom(70, 500, 400)).toBe(true); // 30px from bottom
    expect(isNearBottom(100, 500, 400)).toBe(true); // exactly at bottom
  });

  it("false when scrolled further than the threshold from the bottom", () => {
    expect(isNearBottom(0, 500, 400)).toBe(false); // 100px from bottom
  });

  it("respects a custom threshold", () => {
    expect(isNearBottom(0, 200, 100, 100)).toBe(true);
    expect(isNearBottom(0, 300, 100, 100)).toBe(false);
  });
});

describe("relativeTime (pure)", () => {
  const now = new Date("2026-01-01T00:10:00.000Z").getTime();

  it("just now for < 5s", () => {
    expect(relativeTime(new Date(now - 2000).toISOString(), now)).toBe("just now");
  });

  it("seconds ago under a minute", () => {
    expect(relativeTime(new Date(now - 12000).toISOString(), now)).toBe("12s ago");
  });

  it("minutes ago under an hour", () => {
    expect(relativeTime(new Date(now - 4 * 60 * 1000).toISOString(), now)).toBe("4m ago");
  });

  it("hours ago under a day", () => {
    expect(relativeTime(new Date(now - 2 * 60 * 60 * 1000).toISOString(), now)).toBe("2h ago");
  });

  it("days ago", () => {
    expect(relativeTime(new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), now)).toBe("3d ago");
  });
});
