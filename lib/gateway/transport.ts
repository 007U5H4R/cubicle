import { GoogleGenAI } from "@google/genai";
import type { GenerateRequest, Source, Transport, Usage } from "./types";
function usageOf(m: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined): Usage {
  return { input: m?.promptTokenCount ?? 0, output: m?.candidatesTokenCount ?? 0 };
}
function sourcesOf(c: unknown): Source[] {
  const chunks = (c as { groundingMetadata?: { groundingChunks?: { web?: { title?: string; uri?: string } }[] } })?.groundingMetadata?.groundingChunks ?? [];
  return chunks.flatMap((g) => (g.web?.uri ? [{ title: g.web.title ?? g.web.uri, url: g.web.uri }] : []));
}
function configOf(req: GenerateRequest) {
  return {
    systemInstruction: req.system,
    abortSignal: req.signal,
    maxOutputTokens: req.maxOutputTokens,
    ...(req.responseSchema ? { responseMimeType: "application/json", responseSchema: req.responseSchema } : {}),
    ...(req.grounded ? { tools: [{ googleSearch: {} }] } : {}),
  };
}
export function realTransport(apiKey: string): Transport {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generate(req) {
      const r = await ai.models.generateContent({ model: req.model, contents: req.user, config: configOf(req) });
      return { text: r.text ?? "", usage: usageOf(r.usageMetadata), sources: sourcesOf(r.candidates?.[0]) };
    },
    async *generateStream(req) {
      const s = await ai.models.generateContentStream({ model: req.model, contents: req.user, config: configOf(req) });
      let last: { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number }; candidates?: unknown[] } | undefined;
      for await (const chunk of s) { if (chunk.text) yield { text: chunk.text }; last = chunk; }
      yield { usage: usageOf(last?.usageMetadata), sources: sourcesOf(last?.candidates?.[0]) };
    },
  };
}
