import { HEADINGS, type ArtifactType } from "@/lib/prompts/headings";

// TKT-14 Dispatch A — pure derivation of writing-checklist progress from a streaming artifact's
// accumulated markdown (`ClientArtifact.content_md`). No markdown lib needed: only `##` (level-2)
// lines matter, matched leniently so real model output (numbered/prefixed headings) counts.

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * `reached[i]` = true iff `HEADINGS[type][i]` has appeared as a `##` line in `md` (a line matching
 * `/^\s*##\s+/` whose remainder, lowercased + whitespace-normalized, contains the heading phrase
 * lowercased + whitespace-normalized). `done` = count of true entries in `reached`.
 *
 * Assumption (not enforced here): the model emits §10 headings in `HEADINGS[type]` order, so in
 * practice `reached` is contiguous-from-top and `done` == "how many headings so far, from the top".
 * The Desk checklist relies on that ordering assumption when it ticks `i < done`.
 */
export function artifactProgress(
  type: ArtifactType,
  md: string,
): { done: number; total: number; reached: boolean[] } {
  const headings = HEADINGS[type];
  const total = headings.length;

  if (!md || !md.trim()) {
    return { done: 0, total, reached: headings.map(() => false) };
  }

  const h2Lines: string[] = [];
  for (const line of md.split("\n")) {
    const match = /^\s*##\s+(.*)$/.exec(line);
    if (match) h2Lines.push(normalize(match[1]));
  }

  const reached = headings.map((heading) => {
    const needle = normalize(heading);
    return h2Lines.some((line) => line.includes(needle));
  });

  const done = reached.filter(Boolean).length;
  return { done, total, reached };
}
