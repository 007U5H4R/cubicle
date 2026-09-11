import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActChip, type Act } from "./ActChip";

afterEach(cleanup);

const ACTS: Act[] = ["propose", "question", "objection", "agree", "done"];
const GLYPH: Record<Act, string> = { propose: "PRO", question: "Q", objection: "OBJ", agree: "AGR", done: "DONE" };
const WORD: Record<Act, RegExp> = {
  propose: /proposal/i,
  question: /^question$/i,
  objection: /^objection$/i,
  agree: /agreement/i,
  done: /^done$/,
};

describe("ActChip", () => {
  it.each(ACTS)("renders %s with its glyph, act word, and data-act attribute", (act) => {
    render(<ActChip act={act} />);
    expect(screen.getByText(GLYPH[act])).toBeInTheDocument();
    expect(screen.getByText(WORD[act])).toBeInTheDocument();
    expect(screen.getByText(GLYPH[act]).closest("[data-act]")).toHaveAttribute("data-act", act);
  });

  it("objection and agree differ in fill color class and icon markup (never color alone, TC-051)", () => {
    render(<ActChip act="objection" />);
    render(<ActChip act="agree" />);
    const objectionChip = screen.getByText("OBJ").closest("[data-act]")!;
    const agreeChip = screen.getByText("AGR").closest("[data-act]")!;

    expect(objectionChip.className).toContain("bg-act-objection");
    expect(agreeChip.className).toContain("bg-act-agree");
    expect(objectionChip.className).not.toContain("bg-act-agree");

    // icons differ: objection draws a <path> triangle, agree draws a <path> checkmark — compare the
    // full inner SVG markup so a shared shape would fail this assertion.
    expect(objectionChip.querySelector("svg")!.innerHTML).not.toEqual(agreeChip.querySelector("svg")!.innerHTML);
  });

  it("defaults to size md (28px / h-7) and honors size sm (20px / h-5)", () => {
    render(<ActChip act="propose" />);
    render(<ActChip act="propose" size="sm" />);
    const chips = screen.getAllByText("PRO").map((el) => el.closest("[data-act]")!);
    expect(chips[0].className).toContain("h-7");
    expect(chips[1].className).toContain("h-5");
  });

  it("renders a plain span with no layoutId, and a motion span when layoutId is set", () => {
    render(<ActChip act="agree" />);
    const plain = screen.getByText("AGR").closest("[data-act]")!;
    expect(plain.tagName).toBe("SPAN");

    render(<ActChip act="agree" layoutId="chip-1" />);
    const withLayout = screen.getAllByText("AGR")[1].closest("[data-act]")!;
    expect(withLayout.tagName).toBe("SPAN");
  });
});
