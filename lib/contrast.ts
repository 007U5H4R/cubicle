/** Parses an `rgb(r, g, b)` or `rgba(r, g, b, a)` string (as returned by getComputedStyle) into 0-255 channel values. */
function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (!match) {
    throw new Error(`contrastRatio: unable to parse color "${color}"`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** WCAG relative luminance for a single sRGB channel (0-255). */
function channelLuminance(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * DES-003: some Chrome builds serialize `getComputedStyle(...).color` for an oklch()-declared
 * value as CSS `lab(L a b)` (a wider-gamut color that happens to be representable exactly, rather
 * than rounding to rgb()) instead of rgb(). Parses that form directly.
 */
function parseLab(color: string): [number, number, number] | null {
  const match = color.match(/^lab\(\s*([-\d.]+)%?\s+([-\d.]+)\s+([-\d.]+)/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * CIE Lab (D50) -> relative luminance, per the CSS Color 4 sample conversion math. WCAG relative
 * luminance is defined as 0.2126R+0.7152G+0.0722B on *linear* sRGB channels, which is exactly the
 * Y row of the sRGB<->XYZ(D65) matrix — so converting Lab -> XYZ(D50) -> XYZ(D65) and reading off Y
 * gives relative luminance directly, without a full round trip through RGB.
 */
function labRelativeLuminance(L: number, a: number, b: number): number {
  const kappa = 24389 / 27;
  const epsilon = 216 / 24389;
  const fy = (L + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const fx3 = fx ** 3;
  const fz3 = fz ** 3;
  const xr = fx3 > epsilon ? fx3 : (116 * fx - 16) / kappa;
  const yr = L > kappa * epsilon ? ((L + 16) / 116) ** 3 : L / kappa;
  const zr = fz3 > epsilon ? fz3 : (116 * fz - 16) / kappa;

  // D50 reference white (CSS Color 4 Appendix D)
  const whiteD50 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585];
  const xD50 = xr * whiteD50[0];
  const yD50 = yr * whiteD50[1];
  const zD50 = zr * whiteD50[2];

  // Y row only of the D50->D65 Bradford chromatic-adaptation matrix (CSS Color 4 Appendix D).
  const y =
    -0.028369706963208136 * xD50 + 1.0099954580058226 * yD50 + 0.021041398966943008 * zD50;

  return Math.min(1, Math.max(0, y));
}

/** WCAG relative luminance of an rgb()/rgba()/lab() color string. */
function relativeLuminance(color: string): number {
  const lab = parseLab(color);
  if (lab) {
    return labRelativeLuminance(lab[0], lab[1], lab[2]);
  }
  const [r, g, b] = parseRgb(color);
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
}

/** WCAG contrast ratio between two rgb()/rgba() color strings, per (L1+0.05)/(L2+0.05) with the lighter color on top. */
export function contrastRatio(colorA: string, colorB: string): number {
  const lumA = relativeLuminance(colorA);
  const lumB = relativeLuminance(colorB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}
