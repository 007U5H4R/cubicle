import { z } from "zod";

const stopReasons = ["done", "cap_messages", "cap_time", "cap_tokens", "repeat"] as const;
export const EVENTS = {
  session_started: z.object({ referrer: z.enum(["direct", "share_link", "campaign"]) }),
  run_started: z.object({ queued: z.boolean() }),
  run_queued_abandoned: z.object({ wait_s: z.number().int() }),
  debate_completed: z.object({ messages: z.number().int(), objections: z.number().int(), stop_reason: z.enum(stopReasons) }),
  pack_completed: z.object({ wall_s: z.number().int(), tokens: z.number().int(), grounded: z.boolean() }),
  run_failed: z.object({ phase: z.enum(["queue", "debate", "deliver"]), reason: z.enum(["model_error", "timeout", "budget"]) }),
  signed_in: z.object({ trigger: z.enum(["save", "share", "limit"]) }),
  pack_saved: z.object({}),
  pack_shared: z.object({}),
  pack_viewed: z.object({ via: z.enum(["share_link", "owner"]) }),
  return_visit: z.object({ days_since_first: z.number().int() }),
} as const;

export type EventName = keyof typeof EVENTS;
export type EventProps<N extends EventName> = z.infer<(typeof EVENTS)[N]>;
export interface EventContext { anonSessionId: string | null; userId?: string | null; runId?: string | null }
export interface EventRow { name: string; props: Record<string, unknown>; anon_session_id: string | null; user_id: string | null; run_id: string | null }
export interface EventSink { insert(row: EventRow): Promise<void> }

/** Writes one allowlisted event. Unknown names or invalid props are dropped (returns false); unknown props are stripped. */
export async function track<N extends EventName>(sink: EventSink, name: N, props: EventProps<N>, ctx: EventContext): Promise<boolean> {
  const schema = (EVENTS as Record<string, z.ZodTypeAny | undefined>)[name];
  if (!schema) return false;
  const parsed = schema.safeParse(props);
  if (!parsed.success) return false;
  await sink.insert({ name, props: parsed.data as Record<string, unknown>, anon_session_id: ctx.anonSessionId, user_id: ctx.userId ?? null, run_id: ctx.runId ?? null });
  return true;
}

/** Server-only sink; lazy import keeps this module importable in tests and client type-checks. */
export function supabaseSink(): EventSink {
  return {
    async insert(row) {
      const { serviceClient } = await import("@/lib/supabase/server");
      const { error } = await serviceClient().from("events").insert(row);
      if (error) console.error(JSON.stringify({ at: "track", name: row.name, error: error.message }));
    },
  };
}
