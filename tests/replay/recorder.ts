import type { Gateway, Usage } from "@/lib/gateway";
import { ARTIFACT_ROLE, ARTIFACT_TYPES, type ArtifactType } from "@/lib/prompts/headings";
import { ROLE_PREFIX } from "@/lib/prompts/roles";
import type { AgentOutput } from "@/lib/engine/envelope";
import type { ArtifactStream, OrchestratorStep, ReplayFixture } from "./fixture";

// TSK-09.1 — the recorder. `recordingGateway` wraps a REAL Gateway, forwards every call unchanged
// (so a live run behaves exactly as it would unwrapped), and captures each chat/stream response into
// the ReplayFixture shape. `scripts/fixture-record.ts` drives a real run through this wrapper and
// writes the committed fixture. The captured fixture holds only model text + token counts — no keys,
// so nothing secret is persisted.

function systemToType(system: string): ArtifactType {
  const type = ARTIFACT_TYPES.find((t) => ROLE_PREFIX[ARTIFACT_ROLE[t]] === system);
  if (!type) throw new Error("recordingGateway.stream(): unknown system prefix");
  return type;
}

const EMPTY_USAGE: Usage = { input: 0, output: 0 };

export interface Recording {
  /** The wrapping Gateway to hand to the engine in place of the real one. */
  gateway: Gateway;
  /** Assemble the captured calls into a ReplayFixture for the given idea. Call after the run ends. */
  build(idea: string): ReplayFixture;
}

/**
 * Wrap a real Gateway so a run through it is recorded. The last orchestrator/agent usage seen wins
 * (the fixture uses one flat count per kind); each artifact's final successful stream is captured
 * (a scan that falls back to ungrounded overwrites its grounded attempt, matching what replays).
 */
export function recordingGateway(real: Gateway): Recording {
  const orchestrator: OrchestratorStep[] = [];
  const agents: AgentOutput[] = [];
  const artifacts = {} as Partial<Record<ArtifactType, ArtifactStream>>;
  let orchestratorUsage: Usage = EMPTY_USAGE;
  let agentUsage: Usage = EMPTY_USAGE;

  const chat = (async (
    kind: "orchestrator" | "agent",
    system: string,
    user: string,
    schema: unknown,
    jsonSchema: object,
    opts?: { signal?: AbortSignal },
  ) => {
    const res = await real.chat(kind, system, user, schema as Parameters<Gateway["chat"]>[3], jsonSchema, opts);
    if (kind === "orchestrator") {
      orchestrator.push(res.data as OrchestratorStep);
      orchestratorUsage = res.usage;
    } else {
      agents.push(res.data as AgentOutput);
      agentUsage = res.usage;
    }
    return res;
  }) as Gateway["chat"];

  const stream = (async function* (kind: "artifact" | "grounded", system: string, user: string, opts?: { signal?: AbortSignal; maxOutputTokens?: number }) {
    const type = systemToType(system);
    const deltas: string[] = [];
    // Capture on the done chunk BEFORE yielding it: the deliver consumer returns out of its for-await
    // as soon as it receives `done`, which calls the generator's .return() and skips any trailing
    // code — so recording must happen before the yield, not after the loop.
    for await (const chunk of real.stream(kind, system, user, opts)) {
      if (chunk.type === "delta") deltas.push(chunk.text);
      else artifacts[type] = { deltas: [...deltas], usage: chunk.usage, grounded: kind === "grounded", sources: chunk.sources };
      yield chunk;
    }
  }) as Gateway["stream"];

  return {
    gateway: { chat, stream },
    build(idea: string): ReplayFixture {
      const complete = {} as Record<ArtifactType, ArtifactStream>;
      for (const type of ARTIFACT_TYPES) {
        const captured = artifacts[type];
        if (!captured) throw new Error(`recordingGateway.build(): no stream captured for ${type}`);
        complete[type] = captured;
      }
      return {
        idea,
        orchestrator,
        agents,
        artifacts: complete,
        usage: { orchestrator: orchestratorUsage, agent: agentUsage },
      };
    },
  };
}
