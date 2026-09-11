import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Office } from "./Office";
import { applyEvent, reset } from "@/lib/client/runStore";

afterEach(cleanup);
beforeEach(() => reset());

const onOpenMock = vi.fn();

vi.mock("@/lib/client/runStream", () => ({
  openRunStream: (
    _body: unknown,
    handlers: { onOpen?: (id: string) => void },
  ) => {
    onOpenMock(_body);
    handlers.onOpen?.("run-123");
    return { close: () => {} };
  },
}));

describe("Office", () => {
  it("keeps the desk quad mounted (same DOM node) and moves the URL to /run/[id] on start", () => {
    render(<Office />);

    const deskBefore = screen.getByTestId("desk-pm");

    const textarea = screen.getByPlaceholderText(/subscription tracker/i);
    fireEvent.change(textarea, { target: { value: "a subscription tracker" } });
    const start = screen.getByRole("button", { name: /start/i });
    fireEvent.click(start);

    expect(onOpenMock).toHaveBeenCalled();
    expect(window.location.pathname).toBe("/run/run-123");

    const deskAfter = screen.getByTestId("desk-pm");
    expect(deskAfter).toBe(deskBefore);
  });

  it("shows the run-level error banner when the run terminates failed (snap.terminal && run.status==='failed')", () => {
    render(<Office />);

    const textarea = screen.getByPlaceholderText(/subscription tracker/i);
    fireEvent.change(textarea, { target: { value: "a subscription tracker" } });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    expect(screen.queryByText(/something went wrong with this run/i)).not.toBeInTheDocument();

    act(() => {
      applyEvent({ run_id: "run-123", seq: 1, type: "run.status", payload: { status: "running", phase: "debate", thinking: "pm" } });
      applyEvent({ run_id: "run-123", seq: 2, type: "run.error", payload: { phase: "debate", reason: "model_error" } });
    });

    const banner = screen.getByText(/something went wrong with this run/i);
    expect(banner.closest('[role="alert"]')).toBeInTheDocument();
  });

  it("shows the QueueCard over the desk quad when snap.queue is queued", () => {
    render(<Office />);

    fireEvent.change(screen.getByPlaceholderText(/subscription tracker/i), { target: { value: "an idea" } });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    act(() => {
      applyEvent({ run_id: "run-123", seq: 1, type: "run.status", payload: { status: "queued", position: 2, eta_s: 15 } });
    });

    expect(screen.getByText(/your office opens in about 15s/i)).toBeInTheDocument();
    expect(screen.getByText(/you're 2 in line/i)).toBeInTheDocument();
  });
});
