import type { Gateway } from "@/lib/gateway";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import type { ReplayFixture } from "./fixture";

// TSK-09.1 — the stub gateway. It IS the whole Gateway the engine talks to, so the real
// @google/genai transport is never constructed: no network, no spend. `chat` pops the next scripted
// orchestrator/agent response by kind; `stream` replays the recorded deltas + done for the artifact
// identified by the system prefix (resolved exactly like deliver.test.ts).

/** Resolve the artifact type from the streaming call's system prefix (the role prefix). */
function systemToType(system: string): ArtifactType {
  const type = ARTIFACT_TYPES.find((t) => ROLE_PREFIX[ARTIFACT_ROLE[t]] === system);
  if (!type) throw new Error("stub stream(): called with an unknown system prefix");
  return type;
}

/**
 * Build a deterministic Gateway that replays `fixture`. Reuses the queue-shift pattern from
 * run.test.ts's scriptGateway, keyed by call kind, plus one recorded stream per artifact type.
 * Running dry (more calls than the fixture scripted) throws rather than silently reusing a response,
 * so a drift between the fixture and the debate is caught loudly.
 */
export function makeStubGateway(fixture: ReplayFixture): Gateway {
  const orchestrator = [...fixture.orchestrator];
  const agents = [...fixture.agents];
  const served: Record<ArtifactType, boolean> = { prd: false, scan: false, copy: false, plan: false };

  const chat = (async (kind: "orchestrator" | "agent") => {
    if (kind === "orchestrator") {
      const next = orchestrator.shift();
      if (!next) throw new Error("stub chat(): no scripted orchestrator decision left");
      return { data: next, usage: fixture.usage.orchestrator };
    }
    const next = agents.shift();
    if (!next) throw new Error("stub chat(): no scripted agent envelope left");
    return { data: next, usage: fixture.usage.agent };
  }) as Gateway["chat"];

  const stream = ((_kind: "artifact" | "grounded", system: string) => {
    const type = systemToType(system);
    if (served[type]) throw new Error(`stub stream(): artifact ${type} was already streamed`);
    served[type] = true;
    const recorded = fixture.artifacts[type];
    return (async function* () {
      for (const text of recorded.deltas) yield { type: "delta", text } as const;
      yield { type: "done", usage: recorded.usage, sources: recorded.sources } as const;
    })();
  }) as Gateway["stream"];

  return { chat, stream };
}
