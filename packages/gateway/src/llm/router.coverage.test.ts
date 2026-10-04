/**
 * Branch coverage for `LlmRouter` paths the main suite (`router.test.ts`) does not reach: the
 * defense-in-depth catch around the availability probe, the overflow-fallback walk's capability
 * floor and unavailable-candidate arms, air-gap exclusion inside `getStatus`'s preferred-route
 * search, the two config accessors, and `generateMarkdown`'s egress-method pass-through.
 *
 * Every provider here is an in-memory fake that records what it was asked; nothing reaches a
 * network or a daemon.
 */
import { describe, expect, test } from "bun:test";
import { type RouteAvailability, RouteAvailabilityProbe } from "./route-availability.ts";
import { LlmRouter, type LlmRouterConfig } from "./router.ts";
import type { LlmGenerateOptions, LlmProvider, ModelRoute } from "./types.ts";

const BASE: LlmRouterConfig = {
  preferLocal: true,
  localModel: "llama3.2",
  minReasoningParams: 7,
  enforceAirGap: false,
};

type Recorder = { provider: LlmProvider; calls: LlmGenerateOptions[] };

/** A provider that serves exactly `models`, answers `available`, and records every generate. */
function fake(
  providerId: string,
  isLocal: boolean,
  models: readonly string[],
  available = true,
): Recorder {
  const calls: LlmGenerateOptions[] = [];
  const provider: LlmProvider = {
    providerId,
    isLocal,
    isAvailable: async () => available,
    listModels: async () => models.map((modelName) => ({ provider: providerId, modelName })),
    generate: async (opts) => {
      calls.push(opts);
      return {
        text: `from ${providerId}`,
        tokensIn: 1,
        tokensOut: 1,
        modelUsed: providerId,
        isLocal,
        provider: providerId,
      };
    },
  };
  return { provider, calls };
}

describe("LlmRouter config accessors", () => {
  test("prefersLocal and enforcesAirGap read back exactly what the config said", () => {
    const a = new LlmRouter({ ...BASE, preferLocal: true, enforceAirGap: false });
    expect(a.prefersLocal()).toBe(true);
    expect(a.enforcesAirGap()).toBe(false);
    const b = new LlmRouter({ ...BASE, preferLocal: false, enforceAirGap: true });
    expect(b.prefersLocal()).toBe(false);
    expect(b.enforcesAirGap()).toBe(true);
  });
});

describe("LlmRouter — a throwing availability probe", () => {
  /** A probe whose check throws for one provider id and answers normally for every other. */
  class ExplodingProbe extends RouteAvailabilityProbe {
    readonly checked: string[] = [];
    constructor(private readonly explodeFor: string) {
      super();
    }
    override async check(route: ModelRoute): Promise<RouteAvailability> {
      this.checked.push(route.routeId);
      if (route.provider.providerId === this.explodeFor) {
        throw new Error("probe exploded");
      }
      return super.check(route);
    }
  }

  test("a probe that throws reads as UNAVAILABLE and the walk moves to the next route", async () => {
    const probe = new ExplodingProbe("ollama");
    const router = new LlmRouter(BASE, probe);
    const local = fake("ollama", true, ["llama3.2"]);
    const remote = fake("anthropic", false, ["claude"]);
    router.registerRoute(local.provider, "llama3.2");
    router.registerRoute(remote.provider, "claude");

    const chosen = await router.selectProvider("classification");
    expect(chosen?.providerId).toBe("anthropic");
    // The local route WAS probed first (preferLocal) — the fallback is a consequence of its
    // probe throwing, not of it being skipped.
    expect(probe.checked).toEqual(["ollama/llama3.2", "anthropic/claude"]);
  });

  test("with only the throwing route registered, selection resolves undefined instead of rejecting", async () => {
    const router = new LlmRouter(BASE, new ExplodingProbe("ollama"));
    router.registerRoute(fake("ollama", true, ["llama3.2"]).provider, "llama3.2");
    await expect(router.selectProvider("classification")).resolves.toBeUndefined();
  });
});

describe("LlmRouter.generate — the overflow-fallback walk", () => {
  test("skips a below-floor candidate and an unavailable one, then truncates on the original route", async () => {
    // The prompt overflows the first route's window (1000 chars ≈ 250 tokens > 0.85 × 100). The
    // fallback walk then sees: the overflowing route itself (does not fit), a local route BELOW
    // the reasoning floor (skipped by the floor check — it would otherwise fit), and a remote route
    // that fits but is unavailable (skipped by the probe). With no fitting fallback left, the
    // prompt is truncated and sent to the ORIGINAL route.
    const router = new LlmRouter(BASE);
    const big = fake("ollama", true, ["big", "small"]);
    const remote = fake("anthropic", false, ["claude"], false);
    router.registerRoute(big.provider, "big", { contextWindow: 100, parameterCount: 8 });
    router.registerRoute(big.provider, "small", { contextWindow: 100_000, parameterCount: 1 });
    router.registerRoute(remote.provider, "claude", {
      contextWindow: 100_000,
      parameterCount: 100,
    });

    const prompt = "x".repeat(1_000);
    const result = await router.generate({ task: "reasoning", prompt });

    expect(result.text).toBe("from ollama");
    expect(big.calls).toHaveLength(1);
    const sent = big.calls[0]?.prompt ?? "";
    expect(sent).toContain("[...truncated...]");
    expect(sent.length).toBeLessThan(prompt.length);
    // Neither skipped candidate was ever invoked.
    expect(remote.calls).toHaveLength(0);
  });

  test("control: the same walk redirects to the remote route once it is available", async () => {
    // Pins that the unavailable-candidate skip above is what kept the prompt local: flip only the
    // remote route's availability and the full, untruncated prompt goes there instead.
    const router = new LlmRouter(BASE);
    const big = fake("ollama", true, ["big", "small"]);
    const remote = fake("anthropic", false, ["claude"], true);
    router.registerRoute(big.provider, "big", { contextWindow: 100, parameterCount: 8 });
    router.registerRoute(big.provider, "small", { contextWindow: 100_000, parameterCount: 1 });
    router.registerRoute(remote.provider, "claude", {
      contextWindow: 100_000,
      parameterCount: 100,
    });

    const prompt = "y".repeat(1_000);
    const result = await router.generate({ task: "reasoning", prompt });

    expect(result.text).toBe("from anthropic");
    expect(remote.calls[0]?.prompt).toBe(prompt);
    expect(big.calls).toHaveLength(0);
  });
});

describe("LlmRouter.getStatus — air-gap inside the preferred-route search", () => {
  test("a remote route ranked FIRST is passed over for the local one, with reason air-gap", async () => {
    // preferLocal=false orders the remote route ahead of the local one, so the preferred-route
    // search meets it first and must exclude it on air-gap grounds rather than report it.
    const router = new LlmRouter({ ...BASE, preferLocal: false, enforceAirGap: true });
    router.registerRoute(fake("anthropic", false, ["claude"]).provider, "claude");
    router.registerRoute(fake("ollama", true, ["llama3.2"]).provider, "llama3.2");

    const status = await router.getStatus();
    expect(status.classification?.providerId).toBe("ollama");
    expect(status.classification?.modelName).toBe("llama3.2");
    expect(status.classification?.reason).toBe("air-gap");
    expect(status.classification?.isAvailable).toBe(true);
  });

  test("with ONLY a remote route registered, air-gap leaves every task without a status", async () => {
    const router = new LlmRouter({ ...BASE, enforceAirGap: true });
    router.registerRoute(fake("anthropic", false, ["claude"]).provider, "claude");
    const status = await router.getStatus();
    expect(status.classification).toBeUndefined();
    expect(status.reasoning).toBeUndefined();
  });
});

describe("LlmRouter.getStatus — a local route outranked by route_priority", () => {
  // `reasonFor` reaches its "preferLocal but the preferred route is remote" branch here only via
  // `routePriority` (a pin would answer "task-pin" first). It then asks whether a registered local
  // route was skipped for the capability FLOOR, which needs the floor scan to walk PAST a local
  // route that meets it. NOTE: the resulting label, "no-local-provider", is what the code emits
  // today, and it is not accurate in this shape — a local provider IS registered; it is outranked
  // by `route_priority`. Pinned as current behaviour (see the batch report), not endorsed.
  test("a floor-meeting local route is not reported as below the floor", async () => {
    const router = new LlmRouter({
      ...BASE,
      preferLocal: true,
      routePriority: ["anthropic/claude"],
    });
    router.registerRoute(fake("anthropic", false, ["claude"]).provider, "claude", {
      parameterCount: 100,
    });
    router.registerRoute(fake("ollama", true, ["llama3.2"]).provider, "llama3.2", {
      parameterCount: 8, // >= minReasoningParams (7)
    });
    const status = await router.getStatus();
    expect(status.reasoning?.providerId).toBe("anthropic");
    expect(status.reasoning?.reason).toBe("no-local-provider");
    expect(status.reasoning?.reason).not.toBe("local-below-reasoning-floor");
  });

  test("control: the same ordering with the local route BELOW the floor says so", async () => {
    const router = new LlmRouter({
      ...BASE,
      preferLocal: true,
      routePriority: ["anthropic/claude"],
    });
    router.registerRoute(fake("anthropic", false, ["claude"]).provider, "claude", {
      parameterCount: 100,
    });
    router.registerRoute(fake("ollama", true, ["llama3.2"]).provider, "llama3.2", {
      parameterCount: 1,
    });
    const status = await router.getStatus();
    expect(status.reasoning?.reason).toBe("local-below-reasoning-floor");
    // Classification carries no floor, so the same ordering there is plain route priority.
    expect(status.classification?.reason).toBe("no-local-provider");
  });
});

describe("LlmRouter.generateMarkdown — the egress method", () => {
  test("a caller-supplied egressMethod reaches the provider; an omitted one is absent, not undefined", async () => {
    const router = new LlmRouter(BASE);
    const local = fake("ollama", true, ["llama3.2"]);
    router.registerRoute(local.provider, "llama3.2", { parameterCount: 8 });
    const resolved = await router.resolveForSynthesis();
    expect(resolved).toEqual({ providerId: "ollama", modelName: "llama3.2", isLocal: true });
    if (resolved === undefined) throw new Error("unreachable: asserted above");

    await expect(
      router.generateMarkdown("brief", resolved, "agents.catchup.synthesis"),
    ).resolves.toBe("from ollama");
    await router.generateMarkdown("brief", resolved);

    expect(local.calls[0]).toEqual({
      task: "reasoning",
      prompt: "brief",
      egressMethod: "agents.catchup.synthesis",
    });
    // Spread-conditional: no `egressMethod` KEY at all when the caller passes none.
    expect(local.calls[1]).toEqual({ task: "reasoning", prompt: "brief" });
    expect(Object.hasOwn(local.calls[1] ?? {}, "egressMethod")).toBe(false);
  });
});
