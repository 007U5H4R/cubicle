import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "@/lib/config";
let client: SupabaseClient | undefined;
/** Service-role client. Bypasses RLS. Never import from components/ or page files. */
export function serviceClient(): SupabaseClient {
  const c = config();
  client ??= createClient(c.NEXT_PUBLIC_SUPABASE_URL, c.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  return client;
}
