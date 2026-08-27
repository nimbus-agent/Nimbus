import { describe, expect, test } from "bun:test";
import { RouteAvailabilityProbe } from "./route-availability.ts";
import type { LlmModelInfo, LlmProvider, ModelRoute } from "./types.ts";

function makeProvider(opts: {
  reachable: boolean;
  models: string[];
  onList?: () => void;
}): LlmProvider {
  return {
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
}

/** A route on a specific provider INSTANCE. Which instance a route carries is load-bearing
 *  now that the cache keys on the instance: two routes sharing one daemon must be built
 *  from ONE `makeProvider(...)` call, and two routes on two daemons from two. */
function routeOn(p: LlmProvider, modelName: string): ModelRoute {
  return { routeId: `ollama/${modelName}`, provider: p, modelName, meta: {} };
}

function route(
  modelName: string,
  opts: { reachable: boolean; models: string[]; onList?: () => void },
): ModelRoute {
  return routeOn(makeProvider(opts), modelName);
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
    // ONE provider instance, two routes on it — the shared-daemon case. Built from a single
    // `makeProvider(...)` call deliberately: two separate calls would be two instances, which is
    // a different scenario entirely (see the independence test below) and would make this
    // amortization claim untestable.
    const shared = makeProvider({
      reachable: true,
      models: ["a", "b"],
      onList: () => {
        calls += 1;
      },
    });
    await probe.check(routeOn(shared, "a"));
    await probe.check(routeOn(shared, "b"));
    expect(calls).toBe(1);
  });

  test("two routes on DIFFERENT instances sharing a providerId are probed independently", async () => {
    // `assemble.ts` builds a new `OllamaProvider` per `[llm.local.*]` entry, and ollama is
    // exempt from the base-url collision rule — so two ollama routes on two DIFFERENT
    // daemons is legitimate config. Keyed on `providerId`, the second route is answered from
    // the FIRST daemon's model list: `laptop` lists gemma3:12b, so the `ws` route (on a
    // daemon that has no such model, and here is not even reachable) reads as available, the
    // priority walk stops there, and generate() fails at the network call.
    const probe = new RouteAvailabilityProbe(60_000);
    const laptop = makeProvider({ reachable: true, models: ["qwen3:8b", "gemma3:12b"] });
    const workstation = makeProvider({ reachable: false, models: [] });

    const laptopRoute = await probe.check(routeOn(laptop, "qwen3:8b"));
    expect(laptopRoute).toEqual({ available: true, reason: "ok" });

    // The assertion that fails under an id-keyed cache: this must consult the WORKSTATION.
    const wsRoute = await probe.check(routeOn(workstation, "gemma3:12b"));
    expect(wsRoute).toEqual({ available: false, reason: "provider_unreachable" });
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
    // The SAME instance either side of invalidate() — otherwise the second check would miss
    // the cache anyway (different key) and the test would pass whether or not invalidate did
    // anything, which is the shape this repo calls a test that cannot fail.
    const p = makeProvider({
      reachable: true,
      models: ["a"],
      onList: () => {
        calls += 1;
      },
    });
    await probe.check(routeOn(p, "a"));
    probe.invalidate("ollama");
    await probe.check(routeOn(p, "a"));
    expect(calls).toBe(2);
  });

  test("invalidate(providerId) clears EVERY instance carrying that vendor id", async () => {
    let laptopCalls = 0;
    let wsCalls = 0;
    const probe = new RouteAvailabilityProbe(60_000);
    const laptop = makeProvider({
      reachable: true,
      models: ["a"],
      onList: () => {
        laptopCalls += 1;
      },
    });
    const workstation = makeProvider({
      reachable: true,
      models: ["a"],
      onList: () => {
        wsCalls += 1;
      },
    });
    await probe.check(routeOn(laptop, "a"));
    await probe.check(routeOn(workstation, "a"));
    probe.invalidate("ollama");
    await probe.check(routeOn(laptop, "a"));
    await probe.check(routeOn(workstation, "a"));
    expect(laptopCalls).toBe(2);
    expect(wsCalls).toBe(2);
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
