import { describe, expect, test } from "bun:test";
import { LlmRouter } from "../llm/router.ts";
import type { LlmProvider } from "../llm/types.ts";
import { createBriefLlm } from "./brief-llm-adapter.ts";

function router(provider?: LlmProvider): LlmRouter {
  const r = new LlmRouter({
    preferLocal: true,
    remoteModel: "gpt-4o",
    localModel: "llama3.1:8b",
    minReasoningParams: 0,
    enforceAirGap: false,
  });
  if (provider !== undefined) r.registerProvider(provider);
  return r;
}

const stub: LlmProvider = {
  providerId: "ollama",
  isAvailable: async () => true,
  listModels: async () => [],
  generate: async () => ({
    text: "{}",
    tokensIn: 1,
    tokensOut: 1,
    modelUsed: "llama3.1:8b",
    isLocal: true,
    provider: "ollama",
  }),
};

describe("createBriefLlm", () => {
  test("returns null when no provider is available", async () => {
    expect(await createBriefLlm(router()).generateJson("p")).toBeNull();
  });

  test("reports the model actually used and that it stayed local", async () => {
    const out = await createBriefLlm(router(stub)).generateJson("p");
    expect(out).toEqual({ text: "{}", model: "llama3.1:8b", remote: false });
  });

  test("marks a non-local provider as remote", async () => {
    const remote: LlmProvider = {
      ...stub,
      providerId: "remote",
      generate: async () => ({
        text: "{}",
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: "gpt-4o",
        isLocal: false,
        provider: "remote",
      }),
    };
    const out = await createBriefLlm(router(remote)).generateJson("p");
    expect(out?.remote).toBe(true);
    expect(out?.model).toBe("gpt-4o");
  });
});
