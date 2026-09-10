import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
});
