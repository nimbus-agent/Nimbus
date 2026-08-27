import { describe, expect, test } from "bun:test";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import { LlmRouter, type LlmRouterConfig, midTruncate } from "./router.ts";
import type { LlmProvider } from "./types.ts";

function makeFakeProvider(id: "ollama" | "llamacpp" | "remote", available: boolean): LlmProvider {
  return {
    providerId: id,
    isLocal: id !== "remote",
    isAvailable: async () => available,
    // Matches the model callers register this fake under below (localModel for a
    // local id, remoteModel for "remote"), so the model-aware availability probe
    // wired in Task 5 does not fail these route-selection-focused fakes on a model
    // mismatch they were never testing for.
    listModels: async () => [
      {
        provider: id,
        modelName: id === "remote" ? DEFAULT_CONFIG.remoteModel : DEFAULT_CONFIG.localModel,
      },
    ],
    generate: async (_opts) => ({
      text: `response from ${id}`,
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: id,
      isLocal: id !== "remote",
      provider: id,
    }),
  };
}

const DEFAULT_CONFIG: LlmRouterConfig = {
  preferLocal: true,
  remoteModel: "claude-sonnet-4-6",
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

describe("LlmRouter.selectProvider", () => {
  test("returns ollama when preferLocal=true and ollama is available", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("agent_step");
    expect(provider?.providerId).toBe("ollama");
  });

  test("falls back to remote when local unavailable and enforceAirGap=false", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("agent_step");
    expect(provider?.providerId).toBe("remote");
  });

  test("returns undefined when all providers unavailable", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    const provider = await router.selectProvider("classification");
    expect(provider).toBeUndefined();
  });

  test("enforceAirGap=true never returns remote provider", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, enforceAirGap: true };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("reasoning");
    expect(provider).toBeUndefined();
  });

  test("enforceAirGap=true returns local when available", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, enforceAirGap: true };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("llamacpp", true), DEFAULT_CONFIG.localModel);
    const provider = await router.selectProvider("reasoning");
    expect(provider?.providerId).toBe("llamacpp");
  });

  test("preferLocal=false prefers remote over local", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("classification");
    expect(provider?.providerId).toBe("remote");
  });

  test("per-call preferLocal override prefers local even when config prefers remote", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const overridden = await router.selectProvider("reasoning", { preferLocal: true });
    expect(overridden?.providerId).toBe("ollama");
    // No override: falls back to config, which prefers remote — proves the override is per-call.
    const unoverridden = await router.selectProvider("reasoning");
    expect(unoverridden?.providerId).toBe("remote");
  });

  test("per-call preferLocal override falls back to remote when no local provider is available", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("reasoning", { preferLocal: true });
    expect(provider?.providerId).toBe("remote");
  });
});

describe("LlmRouter.generate", () => {
  test("delegates to selected provider and returns result", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const result = await router.generate({ task: "agent_step", prompt: "hello" });
    expect(result.provider).toBe("ollama");
    expect(result.text).toBe("response from ollama");
  });

  test("throws when no provider is available", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    await expect(router.generate({ task: "classification", prompt: "test" })).rejects.toThrow(
      "No LLM provider available",
    );
  });
});

describe("LlmRouter capability floor", () => {
  test("skips provider below minReasoningParams for reasoning task", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 3,
    });
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("reasoning");
    expect(provider?.providerId).toBe("remote");
  });

  test("selects provider at or above minReasoningParams for reasoning task", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 13,
    });
    const provider = await router.selectProvider("reasoning");
    expect(provider?.providerId).toBe("ollama");
  });

  test("does not apply capability floor to classification task", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 1,
    });
    const provider = await router.selectProvider("classification");
    expect(provider?.providerId).toBe("ollama");
  });

  test("skips small provider for agent_step, falls back to remote", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 3,
    });
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const provider = await router.selectProvider("agent_step");
    expect(provider?.providerId).toBe("remote");
  });
});

function makeCaptureProvider(
  id: "ollama" | "llamacpp" | "remote",
  available: boolean,
  captured: { prompt: string },
  // Defaults to the model callers register this id under via `registerRoute` below
  // (localModel/remoteModel); a caller using an explicit model name (e.g. "small"/"big"
  // below) passes it here too, so the model-aware availability probe matches what was
  // registered.
  models: string[] = [id === "remote" ? DEFAULT_CONFIG.remoteModel : DEFAULT_CONFIG.localModel],
): LlmProvider {
  return {
    providerId: id,
    isLocal: id !== "remote",
    isAvailable: async () => available,
    listModels: async () => models.map((m) => ({ provider: id, modelName: m })),
    generate: async (opts) => {
      captured.prompt = opts.prompt;
      return {
        text: `response from ${id}`,
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: id,
        isLocal: id !== "remote",
        provider: id,
      };
    },
  };
}

describe("LlmRouter context window overflow", () => {
  test("mid-truncates prompt for summarisation when it exceeds context window", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    const captured = { prompt: "" };
    router.registerRoute(makeCaptureProvider("ollama", true, captured), DEFAULT_CONFIG.localModel, {
      contextWindow: 100,
    });
    const longPrompt = "x".repeat(500);
    await router.generate({ task: "summarisation", prompt: longPrompt });
    expect(captured.prompt).toContain("[...truncated...]");
    expect(captured.prompt.length).toBeLessThan(longPrompt.length);
  });

  test("falls back to remote for reasoning when local context window overflows", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    const captured = { prompt: "" };
    router.registerRoute(
      makeCaptureProvider("ollama", true, { prompt: "" }),
      DEFAULT_CONFIG.localModel,
      {
        contextWindow: 100,
      },
    );
    router.registerRoute(makeCaptureProvider("remote", true, captured), DEFAULT_CONFIG.remoteModel);
    const longPrompt = "x".repeat(500);
    await router.generate({ task: "reasoning", prompt: longPrompt });
    expect(captured.prompt).toBe(longPrompt);
  });

  test("truncates onto the local route for reasoning overflow when air-gap is enforced and no fallback route fits", async () => {
    // Old behavior (pre-route-walk) threw unconditionally here, even though there was no
    // remote route registered to "prevent" reaching. The route walk correctly finds no
    // fitting fallback (the only route IS the overflowing one) and truncates, same as the
    // non-air-gapped case would with no other route registered.
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, enforceAirGap: true };
    const router = new LlmRouter(config);
    const captured = { prompt: "" };
    router.registerRoute(makeCaptureProvider("ollama", true, captured), DEFAULT_CONFIG.localModel, {
      contextWindow: 100,
    });
    const longPrompt = "x".repeat(500);
    const result = await router.generate({ task: "reasoning", prompt: longPrompt });
    expect(captured.prompt).toContain("[...truncated...]");
    expect(result.provider).toBe("ollama");
  });

  test("falls through to a route whose context window fits", async () => {
    // Each route gets a DISTINCT provider instance with its own capture object.
    // `makeFakeRouteProvider`'s generate() ignores its input and always returns fixed text
    // keyed on provider id, so with two same-id routes it cannot tell "walked to the fitting
    // route" apart from "truncated on the original" — only asserting on what each instance
    // actually received can.
    // Both routes share providerId "ollama", and the availability probe caches by
    // providerId — a zero TTL forces each check to re-list rather than reuse the OTHER
    // instance's cached model list (which would report "big" unavailable, since the
    // cached list would still say ["small"]).
    const router = new LlmRouter(
      { ...DEFAULT_CONFIG, preferLocal: true },
      new RouteAvailabilityProbe(0),
    );
    const smallCaptured = { prompt: "" };
    const bigCaptured = { prompt: "" };
    router.registerRoute(makeCaptureProvider("ollama", true, smallCaptured, ["small"]), "small", {
      contextWindow: 100,
    });
    router.registerRoute(makeCaptureProvider("ollama", true, bigCaptured, ["big"]), "big", {
      contextWindow: 100_000,
    });
    const longPrompt = "x".repeat(40_000); // ~10k tokens: overflows "small", fits "big"
    await router.generate({ task: "reasoning", prompt: longPrompt });
    expect(bigCaptured.prompt).toBe(longPrompt); // walked to the fitting route, untruncated
    expect(smallCaptured.prompt).toBe(""); // the small route was never invoked
  });

  test("air-gap still refuses a non-local route on overflow", async () => {
    const router = new LlmRouter({ ...DEFAULT_CONFIG, enforceAirGap: true });
    router.registerRoute(makeFakeRouteProvider("ollama", true, true, ["small"]), "small", {
      contextWindow: 100,
    });
    router.registerRoute(makeFakeRouteProvider("gemini", false, true, ["big"]), "big", {
      contextWindow: 100_000,
    });
    // Must truncate onto the local route, never reach the remote one.
    const result = await router.generate({ task: "reasoning", prompt: "x".repeat(40_000) });
    expect(result.provider).toBe("ollama");
  });

  test("short prompt within context window is not truncated", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    const captured = { prompt: "" };
    router.registerRoute(makeCaptureProvider("ollama", true, captured), DEFAULT_CONFIG.localModel, {
      contextWindow: 1000,
    });
    const shortPrompt = "hello world";
    await router.generate({ task: "summarisation", prompt: shortPrompt });
    expect(captured.prompt).toBe(shortPrompt);
  });
});

describe("LlmRouter.getStatus", () => {
  test("populates modelName from localModel for ollama", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.modelName).toBe(DEFAULT_CONFIG.localModel);
  });

  test("populates modelName from remoteModel for remote", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    expect(status.classification?.modelName).toBe(DEFAULT_CONFIG.remoteModel);
  });

  test("isAvailable is true when provider is reachable", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.agent_step?.isAvailable).toBe(true);
  });

  test("isAvailable is false when preferred provider is registered but unreachable", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.isAvailable).toBe(false);
    expect(status.classification?.providerId).toBe("ollama");
  });

  test("returns undefined for task when no provider is registered at all", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    const status = await router.getStatus();
    expect(status.classification).toBeUndefined();
  });

  test("reason is prefer-local when preferLocal=true and local provider selected", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.reason).toBe("prefer-local");
  });

  test("reason is prefer-remote when preferLocal=false and remote provider selected", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    expect(status.classification?.reason).toBe("prefer-remote");
  });

  test("reason is air-gap when enforceAirGap=true and local provider selected", async () => {
    const config: LlmRouterConfig = {
      ...DEFAULT_CONFIG,
      enforceAirGap: true,
      preferLocal: true,
    };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.reason).toBe("air-gap");
  });

  test("reason is no-local-provider when preferLocal=true but only remote is registered", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    expect(status.classification?.reason).toBe("no-local-provider");
  });

  test("reason is no-remote-provider when preferLocal=false but only local is registered", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.reason).toBe("no-remote-provider");
  });

  test("returns all four task types", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(Object.keys(status).sort((a, b) => a.localeCompare(b))).toEqual([
      "agent_step",
      "classification",
      "reasoning",
      "summarisation",
    ]);
  });

  test("reports the fallback generate() would use when the preferred provider is down", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    expect(status.classification?.providerId).toBe("ollama");
    expect(status.classification?.isAvailable).toBe(false);
    expect(status.classification?.fallback).toEqual({
      providerId: "remote",
      modelName: DEFAULT_CONFIG.remoteModel,
    });
  });

  test("no fallback when the preferred provider is available", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    expect(status.classification?.isAvailable).toBe(true);
    expect(status.classification?.fallback).toBeUndefined();
  });

  test("no fallback when the preferred is down and nothing else is available", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    const status = await router.getStatus();
    expect(status.classification?.isAvailable).toBe(false);
    expect(status.classification?.fallback).toBeUndefined();
  });

  test("reason is local-below-reasoning-floor when local exists but misses the floor", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 1,
    });
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const status = await router.getStatus();
    // reasoning carries a capability floor; ollama (1B < minReasoningParams) is skipped → remote.
    expect(status.reasoning?.providerId).toBe("remote");
    expect(status.reasoning?.reason).toBe("local-below-reasoning-floor");
    // classification has no floor, so ollama is still the local pick there.
    expect(status.classification?.providerId).toBe("ollama");
    expect(status.classification?.reason).toBe("prefer-local");
  });

  test("probes each provider's availability at most once across all four tasks", async () => {
    let ollamaProbes = 0;
    const ollama: LlmProvider = {
      ...makeFakeProvider("ollama", true),
      isAvailable: async () => {
        ollamaProbes += 1;
        return true;
      },
    };
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(ollama, DEFAULT_CONFIG.localModel);
    await router.getStatus();
    expect(ollamaProbes).toBe(1);
  });
});

describe("midTruncate", () => {
  test("returns string unchanged when shorter than maxChars", () => {
    expect(midTruncate("hello", 100)).toBe("hello");
  });

  test("returns string unchanged at exactly maxChars", () => {
    const text = "a".repeat(10);
    expect(midTruncate(text, 10)).toBe(text);
  });

  test("inserts truncation marker and keeps first and last halves", () => {
    const text = "A".repeat(20) + "B".repeat(20);
    const result = midTruncate(text, 20);
    expect(result).toContain("[...truncated...]");
    expect(result.startsWith("A".repeat(10))).toBe(true);
    expect(result.endsWith("B".repeat(10))).toBe(true);
  });
});

describe("LlmRouter.resolveForSynthesis", () => {
  test("a LOCAL provider kind resolves isLocal: true — via the REAL provider.isLocal, not a stub", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    // This is the security-relevant assertion: `isLocal` comes from the resolved route's
    // REAL `provider.isLocal`, never from a caller-supplied flag — a caller deciding
    // `[agents].synthesis = "local"` vs egress-ledgering trusts THIS value.
    expect(resolved).toEqual({
      providerId: "ollama",
      modelName: DEFAULT_CONFIG.localModel,
      isLocal: true,
    });
  });

  test("a REMOTE provider kind resolves isLocal: false", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const resolved = await router.resolveForSynthesis();
    expect(resolved).toEqual({
      providerId: "remote",
      modelName: DEFAULT_CONFIG.remoteModel,
      isLocal: false,
    });
  });

  test("llamacpp (the second local provider kind) also resolves isLocal: true", async () => {
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, enforceAirGap: true };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("llamacpp", true), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    expect(resolved?.isLocal).toBe(true);
  });

  test("returns undefined when no provider is available, exactly like selectProvider", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", false), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    expect(resolved).toBeUndefined();
  });

  test("honors the reasoning capability floor, same as selectProvider('reasoning')", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel, {
      parameterCount: 1,
    });
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);
    const resolved = await router.resolveForSynthesis();
    expect(resolved?.providerId).toBe("remote");
  });

  test("an explicit preferLocal argument overrides config.preferLocal for this call only", async () => {
    // The whole point of the `preferLocal` parameter: with config.preferLocal = false, a bare
    // resolveForSynthesis() call still reads that config (remote-first priority) and resolves the
    // remote provider even though a healthy local one is registered — but a caller (agent brief
    // synthesis) that passes `true` explicitly gets the local provider instead, regardless of the
    // config default. Both providers are AVAILABLE here, so only priority order decides which one
    // is picked.
    const config: LlmRouterConfig = { ...DEFAULT_CONFIG, preferLocal: false };
    const router = new LlmRouter(config);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    router.registerRoute(makeFakeProvider("remote", true), DEFAULT_CONFIG.remoteModel);

    const viaConfigDefault = await router.resolveForSynthesis();
    expect(viaConfigDefault).toEqual({
      providerId: "remote",
      modelName: DEFAULT_CONFIG.remoteModel,
      isLocal: false,
    });

    const viaExplicitTrue = await router.resolveForSynthesis(true);
    expect(viaExplicitTrue).toEqual({
      providerId: "ollama",
      modelName: DEFAULT_CONFIG.localModel,
      isLocal: true,
    });
  });
});

describe("LlmRouter.generateMarkdown", () => {
  test("invokes the EXACT resolved provider and returns its generated text", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    if (resolved === undefined) throw new Error("expected a resolved provider");
    const markdown = await router.generateMarkdown("write a brief", resolved);
    expect(markdown).toBe("response from ollama");
  });

  test("throws when the resolved provider is no longer registered", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeProvider("ollama", true), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    if (resolved === undefined) throw new Error("expected a resolved provider");
    // The provider that answered resolveForSynthesis() is no longer registered by the time
    // generateMarkdown() is called (e.g. hot-unregistered between the two calls).
    const router2 = new LlmRouter(DEFAULT_CONFIG);
    await expect(router2.generateMarkdown("prompt", resolved)).rejects.toThrow(
      'LLM provider "ollama" is no longer registered',
    );
  });

  test("passes the prompt through to the underlying provider's generate() call", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    const captured = { prompt: "" };
    router.registerRoute(makeCaptureProvider("ollama", true, captured), DEFAULT_CONFIG.localModel);
    const resolved = await router.resolveForSynthesis();
    if (resolved === undefined) throw new Error("expected a resolved provider");
    await router.generateMarkdown("the exact prompt text", resolved);
    expect(captured.prompt).toBe("the exact prompt text");
  });
});

function makeFakeRouteProvider(
  id: string,
  isLocal: boolean,
  available: boolean,
  // The models this fake's daemon reports — must include whatever model name the
  // caller then registers this provider under, or the model-aware availability
  // probe (Task 5) reports `model_absent` regardless of `available`.
  models: string[] = [],
): LlmProvider {
  return {
    providerId: id,
    isLocal,
    isAvailable: async () => available,
    listModels: async () => models.map((m) => ({ provider: id, modelName: m })),
    generate: async () => ({
      text: `response from ${id}`,
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: id,
      isLocal,
      provider: id,
    }),
  };
}

describe("LlmRouter route registration", () => {
  test("two models on ONE runtime both survive registration", async () => {
    // RED-PROVE: on the pre-refactor Map<LlmProviderKind, LlmProvider> the second
    // register overwrote the first, so this asserted 1 where it should assert 2.
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b");
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "gemma3:12b");

    const ids = router
      .routes()
      .map((r) => r.routeId)
      .sort();
    expect(ids).toEqual(["ollama/gemma3:12b", "ollama/qwen3:8b"]);
  });

  test("a route is addressable by its id", () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b");
    expect(router.routeFor("ollama/qwen3:8b")?.modelName).toBe("qwen3:8b");
    expect(router.routeFor("ollama/nope")).toBeUndefined();
  });

  test("re-registering the SAME routeId replaces it rather than duplicating", () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b");
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b", {
      parameterCount: 8,
    });
    expect(router.routes()).toHaveLength(1);
    expect(router.routes()[0]?.meta.parameterCount).toBe(8);
  });

  test("selectProvider prefers a local route when preferLocal=true", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(
      makeFakeRouteProvider("gemini", false, true, ["gemini-2.5-pro"]),
      "gemini-2.5-pro",
    );
    router.registerRoute(makeFakeRouteProvider("ollama", true, true, ["qwen3:8b"]), "qwen3:8b");
    const provider = await router.selectProvider("agent_step");
    expect(provider?.providerId).toBe("ollama");
  });

  test("enforceAirGap skips every non-local route, whatever its id", async () => {
    const router = new LlmRouter({ ...DEFAULT_CONFIG, enforceAirGap: true });
    // The model list is supplied and matches, so the ONLY thing that can make this
    // route unavailable is the air-gap skip itself — without this the route would
    // read as model_absent regardless of enforceAirGap, and the test would pass for
    // the wrong reason.
    router.registerRoute(
      makeFakeRouteProvider("gemini", false, true, ["gemini-2.5-pro"]),
      "gemini-2.5-pro",
    );
    // A vendor id this code has never seen must still be refused, because isLocal
    // is declared false — not because "gemini" is on a list somewhere.
    const provider = await router.selectProvider("agent_step");
    expect(provider).toBeUndefined();
  });

  test("the unnamed tail after route_priority still honours preferLocal", async () => {
    const router = new LlmRouter({
      ...DEFAULT_CONFIG,
      preferLocal: true,
      routePriority: ["gemini/gemini-2.5-pro"], // an explicit remote FIRST choice
    });
    router.registerRoute(makeFakeRouteProvider("gemini", false, true), "gemini-2.5-pro");
    router.registerRoute(makeFakeRouteProvider("xai", false, true), "grok-4");
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b");
    // Registration order puts xai (remote) before ollama (local); preferLocal must
    // reorder the tail so the local route is tried before the unranked remote one.
    const ids = (router as unknown as { orderedRoutes(p?: boolean): { routeId: string }[] })
      .orderedRoutes(true)
      .map((r) => r.routeId);
    expect(ids).toEqual(["gemini/gemini-2.5-pro", "ollama/qwen3:8b", "xai/grok-4"]);
  });

  test("selectRoute returns the full ModelRoute, not just the provider", async () => {
    const router = new LlmRouter(DEFAULT_CONFIG);
    router.registerRoute(makeFakeRouteProvider("ollama", true, true, ["qwen3:8b"]), "qwen3:8b");
    const route = await router.selectRoute("reasoning");
    expect(route?.modelName).toBe("qwen3:8b");
    expect(route?.routeId).toBe("ollama/qwen3:8b");
    expect(route?.provider.providerId).toBe("ollama");
  });

  test("the walk falls THROUGH a route whose model is not pulled", async () => {
    // Without per-route (model-aware) availability this stops at the first route and
    // returns it, because the daemon is up even though the configured model was never
    // pulled. That is the whole defect this task fixes.
    //
    // Both routes share providerId "ollama" — the availability probe caches by
    // providerId, so a zero TTL is used (rather than a distinct vendor id) to force
    // each check to re-list against its OWN fake instance, which is what a real daemon
    // would do too.
    const absent = makeFakeRouteProvider("ollama", true, true, ["other"]);
    const present = makeFakeRouteProvider("ollama", true, true, ["present"]);
    const router = new LlmRouter(
      { ...DEFAULT_CONFIG, routePriority: ["ollama/missing", "ollama/present"] },
      new RouteAvailabilityProbe(0),
    );
    router.registerRoute(absent, "missing");
    router.registerRoute(present, "present");
    const chosen = await router.selectRoute("reasoning");
    expect(chosen?.modelName).toBe("present");
  });
});
