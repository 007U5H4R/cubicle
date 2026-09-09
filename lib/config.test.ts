import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
const base = { GEMINI_API_KEY: "k", NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s" };
describe("loadConfig", () => {
  it("applies the eight §2.3 defaults", () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({ MODEL_AGENT: "gemini-3.8-flash", MODEL_ORCHESTRATOR: "gemini-3.5-flash-lite", RUN_CONCURRENCY_CAP: 10, RUN_DAILY_CAP: 300, RUN_TOKEN_CAP: 60000, RUN_WALL_CAP_S: 90, DEBATE_MSG_CAP: 6, DEBATE_WALL_CAP_S: 45 });
  });
  it("throws a readable error when GEMINI_API_KEY is missing", () => {
    const { GEMINI_API_KEY: _, ...env } = base;
    expect(() => loadConfig(env)).toThrow(/GEMINI_API_KEY/);
  });
  it("throws when a Supabase key is missing", () => {
    const { SUPABASE_SERVICE_ROLE_KEY: _, ...env } = base;
    expect(() => loadConfig(env)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
  it("coerces numeric caps from strings", () => {
    expect(loadConfig({ ...base, RUN_CONCURRENCY_CAP: "1" }).RUN_CONCURRENCY_CAP).toBe(1);
  });
});
