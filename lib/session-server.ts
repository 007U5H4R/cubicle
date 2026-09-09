import "server-only";
import { headers } from "next/headers";
import { serviceClient } from "@/lib/supabase/server";
import { supabaseSink, track } from "@/lib/events";
import type { Referrer } from "@/lib/session";
/** Returns the anonymous session id; on the first request of a new session inserts the row and emits session_started. */
export async function ensureSession(): Promise<string | null> {
  const h = await headers();
  const id = h.get("x-cub-sid");
  if (!id) return null;
  if (h.get("x-cub-new") === "1") {
    const referrer = (h.get("x-cub-referrer") ?? "direct") as Referrer;
    const { error } = await serviceClient().from("anon_sessions").upsert({ id, referrer }, { onConflict: "id", ignoreDuplicates: true });
    if (!error) await track(supabaseSink(), "session_started", { referrer }, { anonSessionId: id });
  }
  return id;
}
