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
  if (provider !== undefined)
    r.registerRoute(provider, provider.isLocal ? "llama3.1:8b" : "gpt-4o");
  return r;
}

const stub: LlmProvider = {
  providerId: "ollama",
  isLocal: true,
  isAvailable: async () => true,
  // Must report the model it registers under ("llama3.1:8b", matching the `registerRoute`
  // call above/below for an `isLocal` provider) — route availability (Task 5) requires the
  // daemon reachable AND the route's own modelName among the models it reports, so an empty
  // listing here makes every route `model_absent` regardless of `isAvailable()`.
  listModels: async () => [{ provider: "ollama", modelName: "llama3.1:8b" }],
  generate: async () => ({
    text: "{}",
    tokensIn: 1,
    tokensOut: 1,
    modelUsed: "llama3.1:8b",
    isLocal: true,
    provider: "ollama",
  }),
};

// A non-local double. `isLocal: false` is set explicitly here (not inherited via a `{ ...stub }`
// spread, which would silently keep `isLocal: true` from `stub` and make this register as a
// LOCAL route under `config.localModel` instead of `config.remoteModel` — a second, latent
// fixture bug this fix also closes) and `listModels` reports `config.remoteModel`
// ("gpt-4o"), the model this provider actually registers under once `isLocal` is correct.
function makeRemoteStub(): LlmProvider {
  return {
    providerId: "remote",
    isLocal: false,
    isAvailable: async () => true,
    listModels: async () => [{ provider: "remote", modelName: "gpt-4o" }],
    generate: async () => ({
      text: "{}",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "gpt-4o",
      isLocal: false,
      provider: "remote",
    }),
  };
}

describe("createBriefLlm", () => {
  test("returns null when no provider is available", async () => {
    expect(await createBriefLlm(router(), true).generateJson("p")).toBeNull();
  });

  test("reports the model actually used and that it stayed local", async () => {
    const out = await createBriefLlm(router(stub), true).generateJson("p");
    expect(out).toEqual({ text: "{}", model: "llama3.1:8b", remote: false });
  });

  test("marks a non-local provider as remote", async () => {
    const remote = makeRemoteStub();
    const out = await createBriefLlm(router(remote), true).generateJson("p");
    expect(out?.remote).toBe(true);
    expect(out?.model).toBe("gpt-4o");
  });

  test("forwards preferLocal=true to the router, choosing local even when router config prefers remote", async () => {
    const r = new LlmRouter({
      preferLocal: false,
      remoteModel: "gpt-4o",
      localModel: "llama3.1:8b",
      minReasoningParams: 0,
      enforceAirGap: false,
    });
    r.registerRoute(stub, "llama3.1:8b");
    r.registerRoute(makeRemoteStub(), "gpt-4o");
    const out = await createBriefLlm(r, true).generateJson("p");
    expect(out).toEqual({ text: "{}", model: "llama3.1:8b", remote: false });
  });

  test("forwards preferLocal=false to the router, choosing remote even when local is registered first", async () => {
    const r = new LlmRouter({
      preferLocal: true,
      remoteModel: "gpt-4o",
      localModel: "llama3.1:8b",
      minReasoningParams: 0,
      enforceAirGap: false,
    });
    r.registerRoute(stub, "llama3.1:8b");
    r.registerRoute(makeRemoteStub(), "gpt-4o");
    const out = await createBriefLlm(r, false).generateJson("p");
    expect(out).toEqual({ text: "{}", model: "gpt-4o", remote: true });
  });
});
