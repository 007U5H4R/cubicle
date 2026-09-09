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

/** WCAG relative luminance of an rgb()/rgba() color string. */
function relativeLuminance(color: string): number {
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
