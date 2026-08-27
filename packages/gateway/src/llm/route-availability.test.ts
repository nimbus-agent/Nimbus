import { describe, expect, test } from "bun:test";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import type { LlmModelInfo, LlmProvider, ModelRoute } from "./types.ts";

function route(
  modelName: string,
  opts: { reachable: boolean; models: string[]; onList?: () => void },
): ModelRoute {
  const provider: LlmProvider = {
    providerId: "ollama",
    isLocal: true,
    isAvailable: async () => opts.reachable,
    listModels: async (): Promise<LlmModelInfo[]> => {
      opts.onList?.();
      return opts.models.map((m) => ({ provider: "ollama", modelName: m }));
    },
    generate: async () => {
      throw new Error("not called");
    },
  };
  return { routeId: `ollama/${modelName}`, provider, modelName, meta: {} };
}

describe("RouteAvailabilityProbe", () => {
  test("a reachable daemon WITHOUT the model is unavailable", async () => {
    const probe = new RouteAvailabilityProbe();
    const r = await probe.check(route("gemma3:12b", { reachable: true, models: ["qwen3:8b"] }));
    expect(r).toEqual({ available: false, reason: "model_absent" });
  });

  test("a reachable daemon WITH the model is available", async () => {
    const probe = new RouteAvailabilityProbe();
    const r = await probe.check(route("qwen3:8b", { reachable: true, models: ["qwen3:8b"] }));
    expect(r).toEqual({ available: true, reason: "ok" });
  });

  test("an unreachable provider is distinguished from an absent model", async () => {
    const probe = new RouteAvailabilityProbe();
    const r = await probe.check(route("qwen3:8b", { reachable: false, models: [] }));
    expect(r).toEqual({ available: false, reason: "provider_unreachable" });
  });

  test("a tag matches when the route omits the :tag suffix", async () => {
    // `local_model = "qwen3"` against a daemon reporting "qwen3:8b" must match, or
    // every existing config breaks on upgrade.
    const probe = new RouteAvailabilityProbe();
    const r = await probe.check(route("qwen3", { reachable: true, models: ["qwen3:8b"] }));
    expect(r.available).toBe(true);
  });

  test("listModels is called ONCE for two routes on the same provider within the TTL", async () => {
    let calls = 0;
    const probe = new RouteAvailabilityProbe(60_000);
    const opts = {
      reachable: true,
      models: ["a", "b"],
      onList: () => {
        calls += 1;
      },
    };
    await probe.check(route("a", opts));
    await probe.check(route("b", opts));
    expect(calls).toBe(1);
  });

  test("a listModels rejection is unavailable, not a thrown probe", async () => {
    const provider: LlmProvider = {
      providerId: "ollama",
      isLocal: true,
      isAvailable: async () => true,
      listModels: async () => {
        throw new Error("boom");
      },
      generate: async () => {
        throw new Error("not called");
      },
    };
    const probe = new RouteAvailabilityProbe();
    const r = await probe.check({ routeId: "ollama/a", provider, modelName: "a", meta: {} });
    expect(r.available).toBe(false);
  });

  test("invalidate() forces the next check to re-list", async () => {
    let calls = 0;
    const probe = new RouteAvailabilityProbe(60_000);
    const opts = {
      reachable: true,
      models: ["a"],
      onList: () => {
        calls += 1;
      },
    };
    await probe.check(route("a", opts));
    probe.invalidate("ollama");
    await probe.check(route("a", opts));
    expect(calls).toBe(2);
  });

  test("an unreachable provider is re-probed sooner than a reachable one (split TTL)", async () => {
    // Positive TTL long enough that the sleep below can't cross it; negative TTL short
    // enough that the SAME sleep does. If both reasons shared one TTL this would either
    // fail to re-probe the down provider (TTL too long) or needlessly re-probe the
    // healthy one (TTL too short) — this test can only pass if the two are different.
    const probe = new RouteAvailabilityProbe(10_000, 5);

    let unreachableCalls = 0;
    const unreachable: LlmProvider = {
      providerId: "down",
      isLocal: true,
      isAvailable: async () => {
        unreachableCalls += 1;
        return false;
      },
      listModels: async () => [],
      generate: async () => {
        throw new Error("not called");
      },
    };
    const downRoute: ModelRoute = {
      routeId: "down/x",
      provider: unreachable,
      modelName: "x",
      meta: {},
    };

    let reachableCalls = 0;
    const reachable: LlmProvider = {
      providerId: "up",
      isLocal: true,
      isAvailable: async () => true,
      listModels: async (): Promise<LlmModelInfo[]> => {
        reachableCalls += 1;
        return [{ provider: "up", modelName: "other" }]; // "wanted" stays model_absent
      },
      generate: async () => {
        throw new Error("not called");
      },
    };
    const upRoute: ModelRoute = {
      routeId: "up/wanted",
      provider: reachable,
      modelName: "wanted",
      meta: {},
    };

    await probe.check(downRoute);
    await probe.check(upRoute);
    expect(unreachableCalls).toBe(1);
    expect(reachableCalls).toBe(1);

    // Longer than the negative TTL (5ms), shorter than the positive TTL (10_000ms).
    await new Promise((resolve) => setTimeout(resolve, 30));

    await probe.check(downRoute);
    await probe.check(upRoute);
    expect(unreachableCalls).toBe(2); // negative TTL expired — re-probed
    expect(reachableCalls).toBe(1); // positive TTL still holds — NOT re-probed
  });
});
