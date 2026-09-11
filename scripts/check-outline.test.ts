import { describe, expect, it } from "vitest";
import { checkTree, findViolations } from "./check-outline";

describe("findViolations", () => {
  it("catches a bare `outline: none` with no nearby replacement", () => {
    const css = `:focus {\n  outline: none;\n}\n`;
    const violations = findViolations(css, "fixture.css");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: "fixture.css", line: 2 });
  });

  it("catches a bare outline:none with no spaces", () => {
    const css = `.x{outline:none}`;
    expect(findViolations(css)).toHaveLength(1);
  });

  it("catches a quoted inline-style bare outline: none", () => {
    const tsx = `<div style={{ outline: "none" }} />`;
    expect(findViolations(tsx)).toHaveLength(1);
  });

  it("passes when a box-shadow replacement is present within the context window (CSS)", () => {
    const css = `:focus-visible {\n  outline: none;\n  box-shadow: var(--focus-ring);\n}\n`;
    expect(findViolations(css)).toHaveLength(0);
  });

  it("passes when a boxShadow replacement is present within the context window (inline style)", () => {
    const tsx = `<div style={{ outline: "none", boxShadow: "var(--focus-ring)" }} />`;
    expect(findViolations(tsx)).toHaveLength(0);
  });

  it("does not flag a non-none outline declaration", () => {
    const css = `.desk-objection-flash {\n  outline: 2px solid transparent;\n  outline-offset: 2px;\n}\n`;
    expect(findViolations(css)).toHaveLength(0);
  });
});

describe("checkTree", () => {
  it("passes clean on the current app/ + components/ tree", () => {
    const violations = checkTree(["app", "components"]);
    expect(violations).toEqual([]);
  });
});
