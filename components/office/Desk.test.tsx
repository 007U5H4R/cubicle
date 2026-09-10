import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk, type DeskStateName } from "./Desk";

afterEach(cleanup);

describe("Desk", () => {
  it("renders the idle state: role glyph, Ready pill, role-colored left border", () => {
    render(<Desk role="pm" state="idle" />);
    expect(screen.getByRole("img", { name: /pm/i })).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    const card = screen.getByTestId("desk-pm");
    expect(card.className).toMatch(/border-role-pm/);
  });

  const otherStates: DeskStateName[] = ["thinking", "speaking", "waiting", "writing", "done", "failed"];
  it.each(otherStates)("does not crash for state=%s", (state) => {
    expect(() => render(<Desk role="developer" state={state} />)).not.toThrow();
  });

  it("thinking: shows the Thinking… pill with data-state set", () => {
    render(<Desk role="pm" state="thinking" />);
    expect(screen.getByTestId("desk-pm")).toHaveAttribute("data-state", "thinking");
    expect(screen.getByText(/thinking…/i)).toBeInTheDocument();
  });

  it("speaking: shows the Speaking pill and the preview text via Typewriter", () => {
    render(<Desk role="designer" state="speaking" preview="hello there" />);
    expect(screen.getByText("Speaking")).toBeInTheDocument();
  });

  it("waiting: shows the waiting pill with the badge act icon label", () => {
    render(<Desk role="pm" state="waiting" badgeAct="question" />);
    expect(screen.getByText(/waiting on reply/i)).toBeInTheDocument();
  });

  it("writing: shows the fractional progress pill", () => {
    render(<Desk role="developer" state="writing" progress={{ done: 2, total: 5 }} />);
    expect(screen.getByText(/writing draft…/i)).toBeInTheDocument();
    expect(screen.getByText(/2\/5 sections/i)).toBeInTheDocument();
  });

  it("done: shows the Done pill with a check glyph", () => {
    render(<Desk role="researcher" state="done" />);
    expect(screen.getByText("Done")).toBeInTheDocument();
  });

  it("failed: role=alert, Retry present when onRetry given", () => {
    const onRetry = vi.fn();
    render(<Desk role="designer" state="failed" onRetry={onRetry} />);
    expect(screen.getByTestId("desk-designer")).toHaveAttribute("role", "alert");
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("failed with no onRetry: no Retry button, generic message shown", () => {
    render(<Desk role="pm" state="failed" />);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it("every status pill carries aria-live=polite", () => {
    render(<Desk role="pm" state="idle" />);
    const pill = screen.getByText("Ready").closest('[aria-live="polite"]');
    expect(pill).not.toBeNull();
  });
});
