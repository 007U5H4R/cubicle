import type { Role } from "@/lib/engine/envelope";

/**
 * §10 artifact types — must match the `type` check-constraint values in
 * `supabase/migrations/0001_init.sql` exactly.
 */
export const ARTIFACT_TYPES = ["prd", "scan", "copy", "plan"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** §10 ownership: which role's artifact each type is. */
export const ARTIFACT_ROLE: Record<ArtifactType, Role> = {
  prd: "pm",
  scan: "researcher",
  copy: "designer",
  plan: "developer",
};

/**
 * §10 heading phrases, in fixed order, for each artifact's markdown output.
 * These are the heading TEXT only (not the full §10 line) so a future
 * `## <heading>` match (TKT-14 artifactProgress) works — parentheticals such
 * as the scan's table-column spec are content guidance, not heading text,
 * and are re-emitted by buildDispatch (dispatch.ts) instead.
 */
export const HEADINGS: Record<ArtifactType, string[]> = {
  prd: [
    "Problem",
    "Who it is for",
    "Proposed solution",
    "v1 scope: in / out",
    "One success metric",
    "The open question we argued about",
  ],
  scan: ["Three competitors", "What this means for positioning", "Confidence note"],
  copy: ["Headline", "Subheadline", "Three benefits", "Call to action", "Two objections, answered"],
  plan: [
    "Smallest v1 slice",
    "Suggested stack",
    "Five steps with rough time",
    "What we cut and why",
    "Riskiest assumption to test first",
  ],
};
