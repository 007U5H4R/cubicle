import type { Usage } from "@/lib/gateway";

// price date: 2026-09 (Solution-PRD §9.2) — gemini-3.8-flash $0.75 / $3.75 per 1M tokens (input/output)
export function costCents({ input, output }: Usage): number {
  return Math.round(((input * 0.75 + output * 3.75) / 1e6) * 100);
}
