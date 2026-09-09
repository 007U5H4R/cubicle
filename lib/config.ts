import { z } from "zod";

const schema = z.object({
  GEMINI_API_KEY: z.string().min(1),
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SITE_URL: z.string().url().default("http://localhost:3000"),
  MODEL_AGENT: z.string().default("gemini-3.8-flash"),
  MODEL_ORCHESTRATOR: z.string().default("gemini-3.5-flash-lite"),
  RUN_CONCURRENCY_CAP: z.coerce.number().int().positive().default(10),
  RUN_DAILY_CAP: z.coerce.number().int().positive().default(300),
  RUN_TOKEN_CAP: z.coerce.number().int().positive().default(60000),
  RUN_WALL_CAP_S: z.coerce.number().int().positive().default(90),
  DEBATE_MSG_CAP: z.coerce.number().int().positive().default(6),
  DEBATE_WALL_CAP_S: z.coerce.number().int().positive().default(45),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Cubicle configuration is invalid. Fix these environment variables:\n${lines.join("\n")}`);
  }
  return result.data;
}

let cached: Config | undefined;
export function config(): Config {
  cached ??= loadConfig();
  return cached;
}
