import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Office } from "./Office";

afterEach(cleanup);

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
});
