import { createClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
const url = process.env.RLS_TEST_URL, anon = process.env.RLS_TEST_ANON_KEY, service = process.env.RLS_TEST_SERVICE_KEY;
describe.skipIf(!url)("RLS", () => {
  let privateId = "", sharedId = "";
  beforeAll(async () => {
    const admin = createClient(url!, service!);
    const { data: s } = await admin.from("anon_sessions").insert({ referrer: "direct" }).select("id").single();
    const base = { anon_session_id: s!.id, idea: "rls", model_agent: "m", model_orchestrator: "o" };
    privateId = (await admin.from("runs").insert({ ...base }).select("id").single()).data!.id;
    sharedId = (await admin.from("runs").insert({ ...base, is_shared: true, share_slug: "rls-shared" }).select("id").single()).data!.id;
  });
  it("hides a private run from the anon key", async () => {
    const { data } = await createClient(url!, anon!).from("runs").select("id").eq("id", privateId);
    expect(data).toEqual([]);
  });
  it("shows a shared run to the anon key", async () => {
    const { data } = await createClient(url!, anon!).from("runs").select("id").eq("id", sharedId);
    expect(data).toHaveLength(1);
  });
  it("never exposes events or anon_sessions", async () => {
    const c = createClient(url!, anon!);
    expect((await c.from("events").select("id")).data).toEqual([]);
    expect((await c.from("anon_sessions").select("id")).data).toEqual([]);
  });
});
