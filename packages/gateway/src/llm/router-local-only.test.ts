import { describe, expect, test } from "bun:test";
import { LlmRouter, type LlmRouterConfig } from "./router.ts";
import type { LlmProvider } from "./types.ts";

const CONFIG: LlmRouterConfig = {
  preferLocal: true,
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

function provider(id: "ollama" | "remote", isLocal: boolean, model: string): LlmProvider {
  return {
    providerId: id,
    isLocal,
    isAvailable: async () => false,
    listModels: async () => [{ provider: id, modelName: model }],
    generate: async () => ({
      text: "x",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: model,
      isLocal,
      provider: id,
    }),
  };
}

describe("LlmRouter.answersOnlyLocally (I34: isLocal, never a preference)", () => {
  test("no route at all is not local", async () => {
    expect(await new LlmRouter(CONFIG).answersOnlyLocally("agent_step")).toBe(false);
  });

  test("only local providers: true, even when none is available right now", async () => {
    const router = new LlmRouter(CONFIG);
    router.registerRoute(provider("ollama", true, "llama3.2"), "llama3.2");
    expect(await router.answersOnlyLocally("agent_step")).toBe(true);
  });

  test("a remote route anywhere in the walk makes it false, whatever prefer_local says", async () => {
    for (const preferLocal of [true, false]) {
      const router = new LlmRouter({ ...CONFIG, preferLocal });
      router.registerRoute(provider("ollama", true, "llama3.2"), "llama3.2");
      router.registerRoute(provider("remote", false, "big-remote"), "big-remote");
      expect(await router.answersOnlyLocally("agent_step")).toBe(false);
    }
  });

  test("under enforce_air_gap the remote route is not a destination, so the answer is local", async () => {
    const router = new LlmRouter({ ...CONFIG, enforceAirGap: true });
    router.registerRoute(provider("ollama", true, "llama3.2"), "llama3.2");
    router.registerRoute(provider("remote", false, "big-remote"), "big-remote");
    expect(await router.answersOnlyLocally("agent_step")).toBe(true);
  });

  test("the verdict follows isLocal, not the provider id", async () => {
    const router = new LlmRouter(CONFIG);
    router.registerRoute(provider("remote", true, "m"), "m");
    expect(await router.answersOnlyLocally("agent_step")).toBe(true);
    const router2 = new LlmRouter(CONFIG);
    router2.registerRoute(provider("ollama", false, "m"), "m");
    expect(await router2.answersOnlyLocally("agent_step")).toBe(false);
  });
});
