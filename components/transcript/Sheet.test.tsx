import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Sheet } from "./Sheet";
import { applyEvent, reset } from "@/lib/client/runStore";
import type { Envelope } from "@/lib/engine/envelope";

// Same jsdom virtualizer workaround as TranscriptPanel.test.tsx — the sheet body mounts a real
// TranscriptPanel, so its rows need a non-zero measured viewport to render at all.
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

describe("Sheet", () => {
  it("shows the peek bar labeled Transcript (N) from the store's message count", () => {
    seedMessage({ id: "m1", seq: 1 });
    seedMessage({ id: "m2", seq: 2 });
    seedMessage({ id: "office-1", seq: 3, from_role: "office", to_role: "team" });

    render(<Sheet reduced />);
    expect(screen.getByText("Transcript (2)")).toBeInTheDocument();
  });

  it("renders the peek bar as a real button with an accessible label", () => {
    render(<Sheet reduced />);
    const peek = screen.getByTestId("transcript-sheet-peek");
    expect(peek.tagName).toBe("BUTTON");
    expect(peek).toHaveAccessibleName("Open transcript");
  });

  it("tapping the peek bar opens the sheet (TranscriptPanel body present, state flips to open)", () => {
    render(<Sheet reduced />);
    const peek = screen.getByTestId("transcript-sheet-peek");
    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "closed");

    fireEvent.click(peek);

    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "open");
    expect(screen.getByTestId("transcript-panel")).toBeInTheDocument();
    expect(peek).toHaveAccessibleName("Close transcript");
  });

  it("tapping the peek bar again closes it", () => {
    render(<Sheet reduced />);
    const peek = screen.getByTestId("transcript-sheet-peek");
    fireEvent.click(peek);
    fireEvent.click(peek);
    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "closed");
  });

  it("Escape closes the sheet while open", () => {
    render(<Sheet reduced />);
    fireEvent.click(screen.getByTestId("transcript-sheet-peek"));
    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "open");

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "closed");
  });

  it("clicking the backdrop scrim closes the sheet", () => {
    render(<Sheet reduced />);
    fireEvent.click(screen.getByTestId("transcript-sheet-peek"));
    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "open");

    fireEvent.click(screen.getByTestId("transcript-sheet-scrim"));

    expect(screen.getByTestId("transcript-sheet")).toHaveAttribute("data-state", "closed");
  });
});
