import { z } from "zod";
export const ROLES = ["pm", "researcher", "designer", "developer"] as const;
export const ACTS = ["propose", "question", "objection", "agree", "done"] as const;
export type Role = (typeof ROLES)[number]; export type Act = (typeof ACTS)[number]; export type To = Role | "team";
export const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
export const agentOutputSchema = z.object({
  to: z.enum([...ROLES, "team"]), act: z.enum(ACTS),
  subject: z.string().refine((s) => wordCount(s) <= 12, "subject must be ≤ 12 words"),
  body: z.string().refine((s) => wordCount(s) <= 80, "body must be ≤ 80 words"),
});
export type AgentOutput = z.infer<typeof agentOutputSchema>;
export const agentOutputJsonSchema = { type: "object", properties: { to: { type: "string", enum: [...ROLES, "team"] }, act: { type: "string", enum: [...ACTS] }, subject: { type: "string" }, body: { type: "string" } }, required: ["to", "act", "subject", "body"] };
export interface Envelope extends AgentOutput { id: string; run_id: string; seq: number; from_role: Role | "office"; to_role: To; reply_to: string | null; hops: number; brief: string | null; created_at: string }
