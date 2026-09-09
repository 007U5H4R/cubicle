import type { z } from "zod";
export type Role = "pm" | "researcher" | "designer" | "developer";
export type CallKind = "orchestrator" | "agent" | "artifact" | "grounded";
export const TIMEOUT_MS: Record<CallKind, number> = { orchestrator: 8000, agent: 15000, artifact: 40000, grounded: 12000 };
export interface Usage { input: number; output: number }
export interface Source { title: string; url: string }
export interface GenerateRequest { model: string; system: string; user: string; responseSchema?: object; grounded?: boolean; maxOutputTokens?: number; signal: AbortSignal }
export interface Transport {
  generate(req: GenerateRequest): Promise<{ text: string; usage: Usage; sources: Source[] }>;
  generateStream(req: GenerateRequest): AsyncIterable<{ text?: string; usage?: Usage; sources?: Source[] }>;
}
export class GatewayError extends Error {
  constructor(public kind: "timeout" | "transient" | "invalid_output" | "fatal", message: string, options?: { cause?: unknown }) { super(message, options); this.name = "GatewayError"; }
}
export interface Gateway {
  chat<T>(kind: "orchestrator" | "agent", system: string, user: string, schema: z.ZodType<T>, jsonSchema: object, opts?: { signal?: AbortSignal }): Promise<{ data: T; usage: Usage }>;
  stream(kind: "artifact" | "grounded", system: string, user: string, opts?: { signal?: AbortSignal; maxOutputTokens?: number }): AsyncIterable<{ type: "delta"; text: string } | { type: "done"; usage: Usage; sources: Source[] }>;
}
