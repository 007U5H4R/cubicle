import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

describe("contrastRatio", () => {
  it("computes max contrast for black on white", () => {
    expect(contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)")).toBeCloseTo(21, 0);
  });

  it("returns 1 for identical colors", () => {
    expect(contrastRatio("rgb(255, 255, 255)", "rgb(255, 255, 255)")).toBe(1);
  });

  // DES-003: some Chrome builds serialize an oklch()-declared computed color as `lab(...)`
  // instead of `rgb(...)` when it lands outside the sRGB gamut's rounded rgb() representation.
  it("parses lab() colors (Chrome's oklch computed-style serialization) equivalently to rgb()", () => {
    // lab(0% 0 0) is pure black, lab(100% 0 0) is pure white — same as the rgb() case above.
    expect(contrastRatio("lab(0% 0 0)", "lab(100% 0 0)")).toBeCloseTo(21, 0);
  });

  it("computes a consistent ratio whether black is expressed as rgb() or lab()", () => {
    const viaRgb = contrastRatio("rgb(0, 0, 0)", "rgb(255, 255, 255)");
    const viaLab = contrastRatio("lab(0% 0 0)", "rgb(255, 255, 255)");
    expect(viaLab).toBeCloseTo(viaRgb, 1);
  });
});
