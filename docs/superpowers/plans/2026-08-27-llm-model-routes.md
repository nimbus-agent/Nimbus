# LLM Model Routes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the LLM router able to hold N `(provider, model)` routes at once, so two local models can serve different tasks — and so slice 2's cloud vendors have a seat to land in.

**Architecture:** `LlmRouter` currently keys `providers` on `LlmProviderKind`, a closed three-member union, so registering a second provider of a kind evicts the first. This plan replaces that key with a `routeId` (`${providerId}/${modelName}`) and keys the map on routes instead. Provider *implementations do not change* — two models means two instances of the same provider class sharing a `providerId`. Alongside the key change, three latent defects are closed while no remote route exists to exercise them: route availability that never checks the model, an egress destination hardcoded to the literal `"model"`, and lifecycle methods that would break on the new map.

**Tech Stack:** Bun 1.2+, TypeScript 7 strict, Biome, `bun:sqlite`, `bun:test`.

**Spec:** [`docs/superpowers/specs/2026-08-27-llm-model-routes-design.md`](../specs/2026-08-27-llm-model-routes-design.md) — §3.1 (routing unit), §3.2 (`isLocal`), §3.3 (resolution order), §3.4 (availability), §3.5 (lifecycle), §3.6 (config), §4 (the two correctness fixes). Review that shaped it: [`…-design-review.md`](../specs/2026-08-27-llm-model-routes-design-review.md).

## Global Constraints

- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **Ships zero cloud vendors.** No provider adapter for Anthropic/OpenAI/Gemini/xAI/Bedrock in this plan. If a task seems to need one, stop — it is slice 2.
- **No schema migration.** `llm_models` already keys `ON CONFLICT(provider, model_name)`; `llm_task_defaults` already stores both columns. If you find yourself writing a `V57`, stop and re-read §3.7.
- **No new `ALLOWED_METHODS` entry.** Eight `llm.*` methods are already renderer-exposed. Adding one means updating `packages/ui/src-tauri/src/gateway_bridge.rs` and its count assertion in the same commit (invariant **I7**) — this plan adds none.
- **No new invariant or `D`-rule.** The one-definition-of-`isLocal` rule ships as a test (spec Open decision 1).
- **Total config back-compat.** Existing `local_model` / `remote_model` / `prefer_local` keys must keep working unchanged and synthesise a single route.
- **`routeId` is opaque inside the router** — never `.split("/")` it there. Parse only at the config/CLI boundary, on the FIRST slash (§3.1).
- **Verify with the CI command, not a scoped one:** `bun test packages/gateway packages/cli scripts`. A `packages/gateway/src`-only run does not load `packages/gateway/test/**` — that gap cost three red legs on #1333.
- **Every task ends with `bun run preflight:fast`** plus the named checks. It does NOT include the coverage floor; that is `verify:docker --changed`.
- Branch: `dev/asaf/llm-model-routes` (already created). Never commit on `main`.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `packages/gateway/src/llm/types.ts` | `ProviderId`, `ModelRoute`, required `isLocal` on `LlmProvider` | 1 |
| `packages/gateway/src/llm/route-id.ts` **(new)** | `makeRouteId` / `parseRouteRef` — the ONLY place a route string is split | 2 |
| `packages/gateway/src/llm/router.ts` | route map, priority walk, gates, `tryRemoteFallback`, `modelNameFor` | 3, 4, 7 |
| `packages/gateway/src/llm/route-availability.ts` **(new)** | per-route availability + short-TTL cache | 5 |
| `packages/gateway/src/llm/registry.ts` | drop 3 hardcoded id arrays; lifecycle keys on `providerId` | 6 |
| `packages/gateway/src/egress/synthesis-egress.ts` | `destination` = `providerId` | 7 |
| `packages/gateway/src/agents/_lib/synthesis-llm.ts` | widen `RecordSynthesisEgressFn` param | 7 |
| `packages/gateway/src/config/nimbus-toml.ts` | `[llm.local.<name>]`, `route_priority` | 8 |
| `packages/gateway/src/platform/assemble.ts` | build N routes from config | 9 |
| `packages/gateway/src/ipc/llm-rpc.ts` | drop `VALID_LLM_PROVIDERS` / `LOCAL_PROVIDERS`; route-shaped status | 10 |

Ordering rationale: types → the one parsing helper → router core → availability → registry → egress → config → wiring → surface. Each task compiles and tests green on its own.

---

### Task 1: Open the provider id and require `isLocal`

The union `LlmProviderKind = "ollama" | "llamacpp" | "remote"` is what caps the router at one provider per kind. Opening it is the precondition for everything else. `isLocal` becomes a required interface field so the three copies of that fact (Task 6, Task 10) have one place to collapse into.

**Files:**

- Modify: `packages/gateway/src/llm/types.ts`
- Modify: `packages/gateway/src/llm/ollama-provider.ts` (add one field)
- Modify: `packages/gateway/src/llm/llamacpp-provider.ts` (add one field)
- Test: `packages/gateway/src/llm/types.test.ts` **(new)**

**Interfaces:**

- Produces: `type ProviderId = string`; `LlmProvider.isLocal: boolean` (required); `type ModelRoute = { routeId: string; provider: LlmProvider; modelName: string; meta: ProviderMeta }`. `LlmProviderKind` is retained as a deprecated alias of `ProviderId` so Tasks 3–10 can migrate call sites incrementally rather than in one commit.

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/llm/types.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { LlamaCppProvider } from "./llamacpp-provider.ts";
import { OllamaProvider } from "./ollama-provider.ts";
import type { LlmProvider } from "./types.ts";

describe("LlmProvider.isLocal", () => {
  test("both shipped providers declare themselves local", () => {
    const providers: LlmProvider[] = [new OllamaProvider(), new LlamaCppProvider()];
    for (const p of providers) {
      expect(p.isLocal).toBe(true);
    }
  });

  test("a provider that omits isLocal does not satisfy the interface", () => {
    // Compile-time proof, asserted at runtime so the test is not vacuous: an object
    // literal missing `isLocal` is not assignable to LlmProvider. If this ever
    // compiles without the field, the interface has been weakened back to optional.
    const withoutIsLocal = {
      providerId: "fake",
      isAvailable: async () => true,
      listModels: async () => [],
      generate: async () => ({
        text: "",
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: "fake",
        isLocal: false,
        provider: "fake",
      }),
    };
    // @ts-expect-error isLocal is required on LlmProvider
    const bad: LlmProvider = withoutIsLocal;
    expect(bad.isLocal).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/llm/types.test.ts`
Expected: FAIL — `p.isLocal` is `undefined` on both providers, and the `@ts-expect-error` is unused (no error to suppress), which `typecheck` flags as `TS2578: Unused '@ts-expect-error' directive`.

- [ ] **Step 3: Open the id and require the field**

In `packages/gateway/src/llm/types.ts`, replace the union and extend the interface:

```ts
/**
 * A provider VENDOR id — `"ollama"`, `"llamacpp"`, and (slice 2) `"gemini"`,
 * `"bedrock"`, ... Deliberately an open string, not a union: the closed union it
 * replaced capped `LlmRouter.providers` at one provider per kind, so registering a
 * second vendor silently evicted the first.
 *
 * NOT unique across routes — two Ollama routes share `"ollama"`. Route identity is
 * `ModelRoute.routeId`. This is the value that reaches the egress ledger as
 * `destination`, so it names a place data can go.
 */
export type ProviderId = string;

/** @deprecated Alias kept so call sites migrate incrementally. Use `ProviderId`. */
export type LlmProviderKind = ProviderId;

export type ModelRoute = {
  readonly routeId: string;
  readonly provider: LlmProvider;
  readonly modelName: string;
  readonly meta: ProviderMeta;
};

export type ProviderMeta = {
  parameterCount?: number;
  contextWindow?: number;
};
```

Add to the `LlmProvider` interface:

```ts
export interface LlmProvider {
  readonly providerId: ProviderId;
  /**
   * Whether this provider runs on this machine. REQUIRED, so omitting it is a
   * compile error rather than a silent `undefined`.
   *
   * Declared by the provider rather than looked up in a module-private set,
   * because that set existed in three places that had to agree. Note the failure
   * direction is safe either way: an unset value is falsy, i.e. REMOTE — which
   * air-gap refuses and the egress appender ledgers.
   */
  readonly isLocal: boolean;
  isAvailable(): Promise<boolean>;
  listModels(): Promise<LlmModelInfo[]>;
  generate(opts: LlmGenerateOptions): Promise<LlmGenerateResult>;
  pullModel?(
    modelName: string,
    opts: { signal?: AbortSignal; onProgress?: (p: PullProgressChunk) => void },
  ): Promise<void>;
}
```

`ProviderMeta` moves here from `router.ts`; re-export it from `router.ts` (`export type { ProviderMeta } from "./types.ts";`) so existing importers keep compiling.

In `ollama-provider.ts`, beside `readonly providerId = "ollama" as const;` add:

```ts
  readonly isLocal = true;
```

In `llamacpp-provider.ts`, beside `readonly providerId = "llamacpp" as const;` add:

```ts
  readonly isLocal = true;
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test packages/gateway/src/llm/` then `bun run typecheck`
Expected: types.test.ts PASSES. Other `llm/` tests still pass — `makeFakeProvider` in `router.test.ts` does not yet set `isLocal`, so **typecheck fails there**. Fix it in the same step by adding `isLocal: id !== "remote"` to the object `makeFakeProvider` returns.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/types.ts packages/gateway/src/llm/ollama-provider.ts \
        packages/gateway/src/llm/llamacpp-provider.ts packages/gateway/src/llm/types.test.ts \
        packages/gateway/src/llm/router.test.ts packages/gateway/src/llm/router.ts
git commit -m "refactor(llm): open ProviderId and require isLocal on LlmProvider"
```

---

### Task 2: The one place a route string is parsed

Model names contain slashes — `LlamaCppProvider` defaults to `"model.gguf"` and realistically holds a path; Ollama accepts `hf.co/user/model`. A naive `split("/")` breaks both. This helper is the only sanctioned parser, so Task 3 can treat `routeId` as opaque.

**Files:**

- Create: `packages/gateway/src/llm/route-id.ts`
- Test: `packages/gateway/src/llm/route-id.test.ts`

**Interfaces:**

- Produces: `makeRouteId(providerId: ProviderId, modelName: string): string`; `parseRouteRef(raw: string): { providerId: ProviderId; modelName: string }` — **throws** `Error` on a malformed ref rather than returning `undefined`, so a bad `route_priority` entry surfaces at config load instead of degrading to default ordering.

- [ ] **Step 1: Write the failing test**

`packages/gateway/src/llm/route-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeRouteId, parseRouteRef } from "./route-id.ts";

describe("makeRouteId", () => {
  test("joins provider and model on a slash", () => {
    expect(makeRouteId("ollama", "qwen3:8b")).toBe("ollama/qwen3:8b");
  });

  test("rejects a providerId containing a slash", () => {
    // The delimiter is only unambiguous because the LEFT side cannot contain it.
    expect(() => makeRouteId("bad/vendor", "m")).toThrow(/providerId/);
  });
});

describe("parseRouteRef", () => {
  test("splits on the FIRST slash, leaving the rest to the model name", () => {
    expect(parseRouteRef("ollama/hf.co/user/model")).toEqual({
      providerId: "ollama",
      modelName: "hf.co/user/model",
    });
  });

  test("keeps a Windows path intact as a model name", () => {
    expect(parseRouteRef("llamacpp/C:\\models\\Llama-3-8B.gguf")).toEqual({
      providerId: "llamacpp",
      modelName: "C:\\models\\Llama-3-8B.gguf",
    });
  });

  test("keeps a POSIX path intact as a model name", () => {
    expect(parseRouteRef("llamacpp//models/meta-llama/Llama-3-8B.gguf")).toEqual({
      providerId: "llamacpp",
      modelName: "/models/meta-llama/Llama-3-8B.gguf",
    });
  });

  test("throws on a ref with no slash", () => {
    expect(() => parseRouteRef("ollama")).toThrow(/expected "<provider>\/<model>"/);
  });

  test("throws on an empty provider or model half", () => {
    expect(() => parseRouteRef("/qwen3")).toThrow(/provider/);
    expect(() => parseRouteRef("ollama/")).toThrow(/model/);
  });

  test("round-trips a model name containing slashes", () => {
    const id = makeRouteId("ollama", "hf.co/user/model");
    expect(parseRouteRef(id)).toEqual({ providerId: "ollama", modelName: "hf.co/user/model" });
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/llm/route-id.test.ts`
Expected: FAIL — `Cannot find module './route-id.ts'`.

- [ ] **Step 3: Write the implementation**

`packages/gateway/src/llm/route-id.ts`:

```ts
// packages/gateway/src/llm/route-id.ts

import type { ProviderId } from "./types.ts";

/**
 * The ONLY place a route reference string is built or split.
 *
 * `routeId` is opaque INSIDE the router — `ModelRoute` already carries `providerId`
 * and `modelName` as separate fields, so parsing the key there would re-derive data
 * the struct holds. Parsing belongs only where a human typed a string:
 * `[llm] route_priority` entries and (slice 4) `nimbus llm use <ref>`.
 *
 * The split is on the FIRST slash and that is load-bearing: model names legitimately
 * contain slashes. `LlamaCppProvider`'s model name defaults to `"model.gguf"` and is
 * realistically a path (`/models/meta-llama/Llama-3-8B.gguf`, or a Windows path with
 * backslashes and a drive colon), and Ollama accepts namespaced tags like
 * `hf.co/user/model`. The delimiter is unambiguous only because the LEFT half cannot
 * contain it, which `makeRouteId` enforces.
 */
export function makeRouteId(providerId: ProviderId, modelName: string): string {
  if (providerId.includes("/")) {
    throw new Error(`providerId must not contain "/": ${providerId}`);
  }
  if (providerId === "") throw new Error("providerId must not be empty");
  if (modelName === "") throw new Error("modelName must not be empty");
  return `${providerId}/${modelName}`;
}

/**
 * Parse a human-supplied route reference. THROWS on anything malformed rather than
 * returning `undefined`: a `route_priority` entry that silently vanished would
 * degrade the router to default ordering with no signal, which is the "a supplied
 * flag decaying into an omitted filter" shape — invisible from the outside.
 */
export function parseRouteRef(raw: string): { providerId: ProviderId; modelName: string } {
  const i = raw.indexOf("/");
  if (i === -1) {
    throw new Error(`malformed route reference "${raw}": expected "<provider>/<model>"`);
  }
  const providerId = raw.slice(0, i);
  const modelName = raw.slice(i + 1); // may itself contain slashes — deliberate
  if (providerId === "") throw new Error(`malformed route reference "${raw}": empty provider`);
  if (modelName === "") throw new Error(`malformed route reference "${raw}": empty model`);
  return { providerId, modelName };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/llm/route-id.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/route-id.ts packages/gateway/src/llm/route-id.test.ts
git commit -m "feat(llm): route-id helper that splits on the first slash only"
```

---

### Task 3: Key the router on routes — red-prove the eviction bug first

This is the core change. Write the test that fails on today's code **first**, so the defect is demonstrated rather than assumed.

**Files:**

- Modify: `packages/gateway/src/llm/router.ts`
- Modify: `packages/gateway/src/decisions/decision-llm-adapter.ts:159`
- Modify: `packages/gateway/src/glossary/glossary-llm-adapter.ts:44`
- Test: `packages/gateway/src/llm/router.test.ts`
- Test: `packages/gateway/src/decisions/decision-llm-adapter.test.ts`, `packages/gateway/src/glossary/glossary-llm-adapter.test.ts` (existing — confirm the local-only refusal still holds)

**Interfaces:**

- Consumes: `ModelRoute`, `ProviderId` (Task 1); `makeRouteId` (Task 2).
- Produces: `LlmRouter.registerRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void`; `LlmRouter.routes(): readonly ModelRoute[]`; `LlmRouter.routeFor(routeId: string): ModelRoute | undefined`. `registerProvider(provider, meta)` is kept as a shim calling `registerRoute(provider, <config default model for that provider>, meta)` so Tasks 6–10 migrate incrementally.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/llm/router.test.ts`. Note `makeFakeProvider` gains a model parameter — update the existing helper in place:

```ts
function makeFakeRouteProvider(id: string, isLocal: boolean, available: boolean): LlmProvider {
  return {
    providerId: id,
    isLocal,
    isAvailable: async () => available,
    listModels: async () => [],
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

    const ids = router.routes().map((r) => r.routeId).sort();
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
    router.registerRoute(makeFakeRouteProvider("gemini", false, true), "gemini-2.5-pro");
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "qwen3:8b");
    const provider = await router.selectProvider("agent_step");
    expect(provider?.providerId).toBe("ollama");
  });

  test("enforceAirGap skips every non-local route, whatever its id", async () => {
    const router = new LlmRouter({ ...DEFAULT_CONFIG, enforceAirGap: true });
    router.registerRoute(makeFakeRouteProvider("gemini", false, true), "gemini-2.5-pro");
    // A vendor id this code has never seen must still be refused, because isLocal
    // is declared false — not because "gemini" is on a list somewhere.
    const provider = await router.selectProvider("agent_step");
    expect(provider).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and verify it fails for the RIGHT reason**

Run: `bun test packages/gateway/src/llm/router.test.ts -t "route registration"`
Expected: FAIL — `router.registerRoute is not a function`. That is a missing-method failure, not the eviction bug. To red-prove the *eviction* specifically, temporarily rewrite the first test against today's API and confirm it reports one provider, then restore:

```ts
// TEMPORARY red-prove, delete after observing the failure:
const r = new LlmRouter(DEFAULT_CONFIG);
r.registerProvider(makeFakeProvider("ollama", true));
r.registerProvider(makeFakeProvider("ollama", true));
// @ts-expect-error reaching into the private map to count seats
expect((r as unknown as { providers: Map<string, unknown> }).providers.size).toBe(2); // FAILS: 1
```

Record the observed `1` in your task notes. Delete the temporary block before proceeding.

- [ ] **Step 3: Implement the route map**

In `packages/gateway/src/llm/router.ts`:

**Delete both `LOCAL_PROVIDER_IDS` and the exported `isLocalProviderKind`.** The audit is already
done — do not re-run it as a conditional:

| Caller | Line | Becomes |
| --- | --- | --- |
| `decisions/decision-llm-adapter.ts` | `159` — `if (!isLocalProviderKind(provider.providerId)) return null;` | `if (!provider.isLocal) return null;` |
| `glossary/glossary-llm-adapter.ts` | `44` — same shape | `if (!provider.isLocal) return null;` |
| `llm/router.ts` | `142` — inside `resolveForSynthesis` | `isLocal: route.provider.isLocal` |
| `llm/router.test.ts` | `386-399` | delete the `describe`; the property is covered by Task 1 and Task 10 |

**These two call sites are security gates, not conveniences** — they are how the glossary and
decisions extraction passes refuse to send indexed private prose to a remote provider. Migrate them
in this task, in this commit; leaving them on a string-keyed predicate is not acceptable as
follow-up work.

**`isLocalProviderKind` must not survive in any form.** Once `ProviderId` is an open string, a
function answering "is this id local?" can only work by consulting a list — which is precisely the
copy this refactor exists to delete, reintroduced at a security gate. Locality is a property of the
registered provider instance; ask the instance.

(For completeness on review item 2.4: `requireLocalProvider`, `LOCAL_PROVIDERS` and the
`LocalProvider` type are confined to `ipc/llm-rpc.ts` and have no callers elsewhere — verified by
grep across `packages/`. Task 10 deletes them with no migration needed.)

Replace the two maps with one:

```ts
  private readonly routeMap = new Map<string, ModelRoute>();

  registerRoute(provider: LlmProvider, modelName: string, meta: ProviderMeta = {}): void {
    const routeId = makeRouteId(provider.providerId, modelName);
    this.routeMap.set(routeId, { routeId, provider, modelName, meta });
  }

  routes(): readonly ModelRoute[] {
    return [...this.routeMap.values()];
  }

  routeFor(routeId: string): ModelRoute | undefined {
    return this.routeMap.get(routeId);
  }

  /** @deprecated Migration shim for call sites not yet on `registerRoute`. */
  registerProvider(provider: LlmProvider, meta: ProviderMeta = {}): void {
    const modelName = provider.isLocal ? this.config.localModel : this.config.remoteModel;
    this.registerRoute(provider, modelName, meta);
  }
```

Rewrite `providerPriority` to return ordered `ModelRoute`s. `routePriority` is a new optional field on `LlmRouterConfig` (`readonly routePriority?: readonly string[]`); add it with a default of `undefined` and update `DEFAULT_CONFIG` in the test file:

```ts
  private orderedRoutes(preferLocal: boolean = this.config.preferLocal): ModelRoute[] {
    const all = this.routes();
    const explicit = this.config.routePriority;
    if (explicit !== undefined && explicit.length > 0) {
      const byId = new Map(all.map((r) => [r.routeId, r]));
      // An unresolvable entry threw at config load (Task 8); anything still missing
      // here was unregistered at runtime, so skipping is correct.
      const ordered = explicit.map((id) => byId.get(id)).filter((r): r is ModelRoute => r !== undefined);
      const named = new Set(ordered.map((r) => r.routeId));
      // The unnamed tail still honours preferLocal. Leaving it in registration order
      // would make the fallback order depend on config-file ordering, which is
      // arbitrary — and would quietly ignore prefer_local for exactly the routes the
      // user did not think to rank. Appending them at all (rather than dropping) is
      // deliberate: a route added to [llm.local.*] but forgotten in route_priority
      // should still be reachable, not invisible.
      return [...ordered, ...byPreference(all.filter((r) => !named.has(r.routeId)), preferLocal)];
    }
    return byPreference(all, preferLocal);
  }

  private static byPreference(routes: ModelRoute[], preferLocal: boolean): ModelRoute[] {
    const local = routes.filter((r) => r.provider.isLocal);
    const remote = routes.filter((r) => !r.provider.isLocal);
    return preferLocal ? [...local, ...remote] : [...remote, ...local];
  }
```

Add the matching test:

```ts
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
  const ids = (router as unknown as { orderedRoutes(p?: boolean): ModelRoute[] })
    .orderedRoutes(true)
    .map((r) => r.routeId);
  expect(ids).toEqual(["gemini/gemini-2.5-pro", "ollama/qwen3:8b", "xai/grok-4"]);
});
```

Rewrite `firstAvailable` to walk routes, keeping the skip-during-walk shape (do NOT pre-filter a pool — see spec §3.3):

```ts
  private async firstAvailableRoute(
    task: LlmTaskType,
    isAvailable: (route: ModelRoute) => Promise<boolean>,
    preferLocal?: boolean,
  ): Promise<ModelRoute | undefined> {
    for (const route of this.orderedRoutes(preferLocal)) {
      if (this.config.enforceAirGap && !route.provider.isLocal) continue;
      if (!this.meetsCapabilityFloor(route, task)) continue;
      if (await isAvailable(route)) return route;
    }
    return undefined;
  }
```

`meetsCapabilityFloor` takes a `ModelRoute` and reads `route.meta.parameterCount`; keep the documented fail-open when it is `undefined`. `modelNameFor` is deleted — a route knows its own model name. `resolveForSynthesis` returns `{ providerId: route.provider.providerId, modelName: route.modelName, isLocal: route.provider.isLocal }`. `generateMarkdown` resolves via `routeFor(makeRouteId(resolved.providerId, resolved.modelName))` and throws the same "no longer registered" error when absent.

- [ ] **Step 4: Run the full llm suite**

Run: `bun test packages/gateway/src/llm/`
Expected: PASS. Existing `selectProvider` / `getStatus` tests must still pass through the `registerProvider` shim — if one fails, the shim's model-name default is wrong, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/router.ts packages/gateway/src/llm/router.test.ts \
        packages/gateway/src/decisions/decision-llm-adapter.ts \
        packages/gateway/src/glossary/glossary-llm-adapter.ts
git commit -m "feat(llm): key the router on (provider, model) routes"
```

---

### Task 4: Route-aware context-overflow fallback

`tryRemoteFallback` does `this.providers.get("remote")` — a key that no longer exists. Spec §4.1: rewrite it as "next fitting route in priority order". No remote route exists in this slice, so this is a pure refactor; the point is to close it before slice 2 makes it live.

**Files:**

- Modify: `packages/gateway/src/llm/router.ts`
- Test: `packages/gateway/src/llm/router.test.ts`

**Interfaces:**

- Consumes: `firstAvailableRoute`, `orderedRoutes` (Task 3).
- Produces: no new public surface. `tryRemoteFallback` is deleted; `fitPromptOrFallback` returns `{ kind: "route"; route: ModelRoute; opts: LlmGenerateOptions }`.

- [ ] **Step 1: Write the failing test**

```ts
describe("LlmRouter context overflow", () => {
  test("falls through to a route whose context window fits", async () => {
    const router = new LlmRouter({ ...DEFAULT_CONFIG, preferLocal: true });
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "small", {
      contextWindow: 100,
    });
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "big", {
      contextWindow: 100_000,
    });
    const result = await router.generate({
      task: "reasoning",
      prompt: "x".repeat(40_000), // ~10k tokens: overflows "small", fits "big"
      });
    expect(result.text).toContain("ollama");
  });

  test("air-gap still refuses a non-local route on overflow", async () => {
    const router = new LlmRouter({ ...DEFAULT_CONFIG, enforceAirGap: true });
    router.registerRoute(makeFakeRouteProvider("ollama", true, true), "small", {
      contextWindow: 100,
    });
    router.registerRoute(makeFakeRouteProvider("gemini", false, true), "big", {
      contextWindow: 100_000,
    });
    // Must truncate onto the local route, never reach the remote one.
    const result = await router.generate({ task: "reasoning", prompt: "x".repeat(40_000) });
    expect(result.provider).toBe("ollama");
  });
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/llm/router.test.ts -t "context overflow"`
Expected: FAIL — the first test truncates on `small` instead of moving to `big`, because `tryRemoteFallback` looks up a `"remote"` key that no route provides.

- [ ] **Step 3: Implement**

Delete `tryRemoteFallback`. In `fitPromptOrFallback`, when the prompt overflows the selected route's window and the task is `reasoning` / `agent_step`, walk `orderedRoutes` for the next route that is available, passes the air-gap and capability gates, **and** whose `meta.contextWindow` is `undefined` or large enough. If none is found, truncate on the original route exactly as today. Keep the existing air-gap `throw` for the case where truncation is not acceptable.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/llm/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/router.ts packages/gateway/src/llm/router.test.ts
git commit -m "fix(llm): context-overflow fallback walks routes, not a 'remote' key"
```

---

### Task 5: Availability means the model answers, not the daemon is up

Spec §3.4. `OllamaProvider.isAvailable()` returns `resp.ok` from `GET /api/tags` without checking `this.modelName` is among them. With one route that is a confusing error; with a priority walk it halts at the first route that lies instead of falling through to one that works.

**Files:**

- Create: `packages/gateway/src/llm/route-availability.ts`
- Modify: `packages/gateway/src/llm/router.ts` (use it in the walk)
- Test: `packages/gateway/src/llm/route-availability.test.ts`

**Interfaces:**

- Consumes: `ModelRoute` (Task 1).
- Produces: `type RouteAvailability = { available: boolean; reason: "ok" | "provider_unreachable" | "model_absent" }`; `class RouteAvailabilityProbe { constructor(ttlMs?: number); check(route: ModelRoute): Promise<RouteAvailability>; }`. The two failure reasons stay distinct because they have different fixes — reporting both as "unavailable" sends the user to the wrong one.

- [ ] **Step 1: Write the failing test**

```ts
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
    const opts = { reachable: true, models: ["a", "b"], onList: () => { calls += 1; } };
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
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/llm/route-availability.test.ts`
Expected: FAIL — `Cannot find module './route-availability.ts'`.

- [ ] **Step 3: Implement**

`packages/gateway/src/llm/route-availability.ts` — cache keyed on `providerId` (the model list is a property of the daemon, not of one route), short TTL so four routes cost one `/api/tags`, and a rejection is caught and reported unavailable rather than propagated. Match on exact name first, then `name.startsWith(`${modelName}:`)` — mirroring the existing tag-tolerant match in `registry.refreshProviderMeta`.

- [ ] **Step 4: Wire it into the walk and run tests**

**The probe must be a single long-lived field on `LlmRouter`**, not constructed inside the walk:

```ts
  private readonly availability = new RouteAvailabilityProbe();
```

Constructing it inside `firstAvailableRoute` would discard the cache on every call, which defeats
the entire purpose — four routes would still cost four `/api/tags` round trips. `probeAvailable`
becomes `(await this.availability.check(route)).available`, keeping the existing catch-to-false.

Three consequences of a long-lived cache that the implementation must handle:

1. **TTL is `30_000` ms**, a named constant, not a magic number. Long enough that resolving a
   four-route table costs one round trip; short enough that a model removed out-of-band
   (`ollama rm`) is noticed without a restart.
2. **A successful `pullModel` must invalidate the cache for that `providerId`.** Otherwise
   `nimbus llm pull gemma3` followed immediately by a request that should use it keeps reporting
   `model_absent` for up to 30 seconds — a bug that looks exactly like the pull having failed.
   `RouteAvailabilityProbe.invalidate(providerId: ProviderId): void`, called from
   `LlmRegistry.pullModel` on success (Task 6 — add it there when this lands).
3. **`getStatus()` already has its own per-call `availabilityCache`** (`Map<…, Promise<boolean>>`)
   built to probe each provider at most once per status call. Delete it — it is now redundant, and
   two caching layers with different lifetimes over the same question is how they drift apart.

Add the invalidation test to Task 5's file:

```ts
test("invalidate() forces the next check to re-list", async () => {
  let calls = 0;
  const probe = new RouteAvailabilityProbe(60_000);
  const opts = { reachable: true, models: ["a"], onList: () => { calls += 1; } };
  await probe.check(route("a", opts));
  probe.invalidate("ollama");
  await probe.check(route("a", opts));
  expect(calls).toBe(2);
});
```

Add a router-level test:

```ts
test("the walk falls THROUGH a route whose model is not pulled", async () => {
  // Without per-route availability this stops at the first route and returns it,
  // because the daemon is up. That is the whole defect.
  const absent = makeFakeRouteProvider("ollama", true, true);
  absent.listModels = async () => [{ provider: "ollama", modelName: "other" }];
  const present = makeFakeRouteProvider("ollama", true, true);
  present.listModels = async () => [{ provider: "ollama", modelName: "present" }];
  const router = new LlmRouter({ ...DEFAULT_CONFIG, routePriority: ["ollama/missing", "ollama/present"] });
  router.registerRoute(absent, "missing");
  router.registerRoute(present, "present");
  const chosen = await router.selectRoute("reasoning");
  expect(chosen?.modelName).toBe("present");
});
```

Note this needs the two fakes to have distinct provider objects; the availability cache is keyed on `providerId`, so give the second `providerId: "ollama2"` or inject a zero TTL. Prefer a zero TTL — a second vendor id would not reflect reality.

Run: `bun test packages/gateway/src/llm/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/route-availability.ts packages/gateway/src/llm/route-availability.test.ts \
        packages/gateway/src/llm/router.ts packages/gateway/src/llm/router.test.ts
git commit -m "fix(llm): route availability checks the model, not just the daemon"
```

---

### Task 6: Registry — drop the hardcoded id lists, key lifecycle on providerId

Three arrays hardcode the closed union (`registry.ts:44`, `:67`, `:87`) and four method signatures hardcode `"ollama" | "llamacpp"`. Spec §3.5: lifecycle keys on `providerId`, model stays an argument — keying on `routeId` would make it impossible to pull a model that has no route yet.

**Files:**

- Modify: `packages/gateway/src/llm/registry.ts`
- Test: `packages/gateway/src/llm/registry.test.ts`

**Interfaces:**

- Consumes: `routes()`, `routeFor()` (Task 3).
- Produces: `addRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void`; `pullModel(providerId: ProviderId, modelName: string, opts?): Promise<void>` — note `providerId` widens from the union to `ProviderId`. `loadModel` / `unloadModel` / `setDefault` widen identically.

- [ ] **Step 1: Write the failing test**

```ts
test("pullModel works for a model that has NO route", async () => {
  // The primary use of pull: fetch a model BEFORE configuring a route for it.
  // Keying lifecycle on routeId would make this impossible.
  const pulled: string[] = [];
  const provider = makeRegistryFakeProvider("ollama", true);
  provider.pullModel = async (m) => { pulled.push(m); };
  const registry = new LlmRegistry({ config: BASE_CONFIG });
  registry.addRoute(provider, "qwen3:8b");
  await registry.pullModel("ollama", "a-model-with-no-route");
  expect(pulled).toEqual(["a-model-with-no-route"]);
});

test("listAllModels covers a vendor id the registry has never heard of", async () => {
  const registry = new LlmRegistry({ config: BASE_CONFIG });
  registry.addRoute(makeRegistryFakeProvider("gemini", false), "gemini-2.5-pro");
  const models = await registry.listAllModels();
  expect(models.some((m) => m.provider === "gemini")).toBe(true);
});
```

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/llm/registry.test.ts -t "no route"`
Expected: FAIL — `registry.addRoute is not a function`; and once added, `listAllModels` returns `[]` for `gemini` because its `providerIds` array names only the three known kinds.

- [ ] **Step 3: Implement**

Replace both `const providerIds = ["ollama", "llamacpp", "remote"] as const` loops with iteration over `this.router.routes()`, deduplicating by `providerId` for `checkAvailability`. Delete the `(this.router as unknown as { providers: Map<...> })` casts — `routes()` is public, so the reach-through is no longer needed. `refreshProviderMeta` iterates routes with `provider.isLocal` instead of the `["ollama","llamacpp"]` literal. Lifecycle methods resolve `this.router.routes().find((r) => r.provider.providerId === providerId)?.provider` and keep the existing "Provider not registered" / "does not support pullModel" errors.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/llm/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/llm/registry.ts packages/gateway/src/llm/registry.test.ts
git commit -m "refactor(llm): registry iterates routes; lifecycle keys on providerId"
```

---

### Task 7: Egress destination names the vendor

Spec §4.2. `synthesis-egress.ts` hardcodes `destination: "model"` and its parameter type structurally drops `providerId`, though the call site has it. With five vendors, `nimbus prove` would report that "a prompt went to a model".

**Files:**

- Modify: `packages/gateway/src/egress/synthesis-egress.ts`
- Modify: `packages/gateway/src/agents/_lib/synthesis-llm.ts` (widen `RecordSynthesisEgressFn`)
- Test: `packages/gateway/src/egress/synthesis-egress.test.ts`

**Interfaces:**

- Consumes: `ResolvedSynthesisProvider` (already carries `providerId`).
- Produces: `recordSynthesisEgress(db, { briefKind, provider: { providerId, modelName, isLocal }, now })`.

- [ ] **Step 1: Write the failing test**

```ts
test("destination is the vendor, not the literal 'model'", () => {
  const db = openTestDb();
  recordSynthesisEgress(db, {
    briefKind: "why",
    provider: { providerId: "gemini", modelName: "gemini-2.5-pro", isLocal: false },
    now: 1_700_000_000_000,
  });
  const row = db.query("SELECT destination, source_type FROM egress_ledger").get() as {
    destination: string;
    source_type: string;
  };
  expect(row.destination).toBe("gemini");
  expect(row.source_type).toBe("model"); // the CLASS stays "model"; the DESTINATION is the vendor
});

test("a local provider still appends nothing", () => {
  const db = openTestDb();
  recordSynthesisEgress(db, {
    briefKind: "why",
    provider: { providerId: "ollama", modelName: "qwen3:8b", isLocal: true },
    now: 1,
  });
  expect(db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()).toEqual({ n: 0 });
});
```

Reuse the existing test file's DB helper rather than writing a new one — read the top of `synthesis-egress.test.ts` first.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/egress/synthesis-egress.test.ts`
Expected: FAIL — `destination` is `"model"`, and the object literal has an excess `providerId` property the parameter type rejects.

- [ ] **Step 3: Implement**

Widen the parameter to `{ readonly providerId: ProviderId; readonly modelName: string; readonly isLocal: boolean }` and set `destination: args.provider.providerId`. **Do not touch the `if (args.provider.isLocal) return;` guard** — deriving locality here rather than accepting a caller boolean is the property that makes a false zero unrepresentable, and it is documented at length in that file. Mirror the widened type in `RecordSynthesisEgressFn` in `synthesis-llm.ts`; the call site already passes the full `resolved` object, so no call-site change is needed.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/egress/ packages/gateway/src/agents/_lib/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/synthesis-egress.ts packages/gateway/src/egress/synthesis-egress.test.ts \
        packages/gateway/src/agents/_lib/synthesis-llm.ts
git commit -m "fix(egress): synthesis destination names the vendor, not the literal 'model'"
```

---

### Task 8: Config — `[llm.local.<name>]` and `route_priority`

Spec §3.6. Total back-compat: existing keys must still work.

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Test: `packages/gateway/src/config/nimbus-toml.test.ts`

**Interfaces:**

- Consumes: `parseRouteRef` (Task 2).
- Produces: `NimbusLlmToml.localRoutes: ReadonlyMap<string, { runtime: string; model: string; baseUrl?: string }>` and `NimbusLlmToml.routePriority: readonly string[]`. Both default to empty in `DEFAULT_NIMBUS_LLM_TOML`, so `loadNimbusLlmFromPath` yields an empty map/array while `parseNimbusTomlLlmSection` (a `Partial`) yields `undefined` when unset. Task 9 consumes the defaults-merged form.

- [ ] **Step 1: Write the failing test**

The existing raw-string entry point is **`parseNimbusTomlLlmSection(source): Partial<NimbusLlmToml>`**
— note `Partial`, so an unset field is `undefined`, not a default. `loadNimbusLlmFromPath` is the
defaults-merged variant and takes a *path*. Both are already imported by
`nimbus-toml.test.ts`; use them rather than inventing a parser.

`parseNimbusTomlLlmSection` delegates to `forEachSectionEntry(source, "[llm]", …)`, which matches a
table header by **exact string equality** — so it sees only `[llm]` keys and cannot observe
`[llm.local.*]` at all. The sub-table scan is genuinely new code, not a switch-case addition.

```ts
test("parses [llm.local.<name>] sub-tables", () => {
  const toml = `
[llm]
prefer_local = true

[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.gemma]
runtime = "ollama"
model = "gemma3:12b"
`;
  const cfg = parseNimbusTomlLlmSection(toml);
  expect([...(cfg.localRoutes ?? new Map()).keys()].sort()).toEqual(["gemma", "qwen3"]);
  expect(cfg.localRoutes?.get("qwen3")?.model).toBe("qwen3:8b");
});

test("legacy local_model still parses and defines no sub-table route", () => {
  const cfg = parseNimbusTomlLlmSection(`[llm]\nlocal_model = "llama3.2"\n`);
  expect(cfg.localModel).toBe("llama3.2");
  // Partial<>: absent, not an empty map. assemble.ts synthesises the route (Task 9).
  expect(cfg.localRoutes).toBeUndefined();
});

test("defaults-merged load exposes an empty route map, not undefined", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-llm-"));
  writeFileSync(join(dir, "nimbus.toml"), `[llm]\nlocal_model = "llama3.2"\n`);
  const cfg = loadNimbusLlmFromConfigDir(dir);
  expect(cfg.localRoutes.size).toBe(0);
  expect(cfg.routePriority).toEqual([]);
});

test("route_priority with a model name containing slashes round-trips", () => {
  const cfg = parseNimbusTomlLlmSection(`[llm]\nroute_priority = ["ollama/hf.co/user/model"]\n`);
  expect(cfg.routePriority).toEqual(["ollama/hf.co/user/model"]);
});

test("a malformed route_priority entry throws at load, it does not vanish", () => {
  expect(() => parseNimbusTomlLlmSection(`[llm]\nroute_priority = ["ollama"]\n`)).toThrow(/route/);
});

test("both llamacpp sub-tables are parsed; collision is Task 9's to catch", () => {
  // The collision check moved to assemble.ts with the rest of validation. Compare
  // RESOLVED base URLs there: two routes that both OMIT base_url resolve to the
  // same default and collide, which a raw-string comparison would miss entirely.
  const toml = `
[llm.local.a]
runtime = "llamacpp"
model = "a.gguf"

[llm.local.b]
runtime = "llamacpp"
model = "b.gguf"
`;
  const cfg = parseNimbusTomlLlmSection(toml);
  expect([...(cfg.localRoutes ?? new Map()).keys()].sort()).toEqual(["a", "b"]);
  expect(cfg.localRoutes?.get("a")?.baseUrl).toBeUndefined();
});

test("a malformed sub-table does not discard the rest of [llm]", () => {
  // Mirrors the [ownership] precedent (nimbus-toml.ts ~1907): one bad block must
  // not zero the section.
  const cfg = parseNimbusTomlLlmSection(`[llm]\nprefer_local = false\n\n[llm.local.]\nmodel = "x"\n`);
  expect(cfg.preferLocal).toBe(false);
});
```

> **⚠ The parser MUST NOT throw. Do not write the two `toThrow` tests above as shown — they are
> superseded by the block below.** They are left visible only so the reasoning is not lost.

**Why a throw here is dangerous, not merely unidiomatic.** `loadTomlSection`
(`config/nimbus-toml.ts:23-32`) wraps every section parse in a **bare catch that returns the
defaults**:

```ts
try { return parse(readFileSync(tomlPath, "utf8")); }
catch { return structuredClone(fallback); }
```

A throw from `parseNimbusTomlLlmSection` is therefore swallowed, and the **entire `[llm]` section
reverts to `DEFAULT_NIMBUS_LLM_TOML`** — silently. That discards `prefer_local`, `local_model`,
`min_reasoning_params` and, critically, `enforce_air_gap`, whose default is **`false`**. So a typo
in one `route_priority` entry would silently disable air-gap on a machine configured for it. That
is a strictly worse outcome than either fail-fast or a diagnostic, and it is invisible.

**Therefore validation is a two-stage split:**

1. **Parse stage (this task) never throws.** `parseNimbusTomlLlmSection` collects `route_priority`
   entries verbatim into `routePriority: string[]` and `[llm.local.*]` blocks into `localRoutes`,
   applying no cross-field validation. A structurally unusable sub-table (empty id) is skipped, as
   the `[ownership]` precedent skips a malformed entry rather than discarding the section.
2. **Validation stage (Task 9, `assemble.ts`) reports and refuses.** Against the loaded config,
   run each `routePriority` entry through `parseRouteRef` and check it resolves to a registered
   route, and check the resolved-`base_url` collision rule. A failure logs an explicit error
   naming the offending entry and **omits that entry**, rather than reverting anything.

Write the two config tests as non-throwing instead:

```ts
test("route_priority entries are collected verbatim, without validation", () => {
  // Validation lives in assemble.ts (Task 9). Throwing here would be swallowed by
  // loadTomlSection's bare catch and silently revert the WHOLE [llm] section to
  // defaults — including enforce_air_gap, which defaults to false.
  const cfg = parseNimbusTomlLlmSection(`[llm]\nroute_priority = ["ollama", "ollama/qwen3"]\n`);
  expect(cfg.routePriority).toEqual(["ollama", "ollama/qwen3"]);
});

test("a malformed sub-table is skipped without discarding the section", () => {
  const cfg = parseNimbusTomlLlmSection(
    `[llm]\nenforce_air_gap = true\n\n[llm.local.]\nmodel = "x"\n`,
  );
  expect(cfg.enforceAirGap).toBe(true); // the security-relevant key SURVIVES
  expect(cfg.localRoutes ?? new Map()).not.toHaveProperty("");
});
```

The second test is the regression guard for the hazard above: assert the *security* key survives a
malformed neighbour, not merely that some key survives.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/src/config/nimbus-toml.test.ts -t "llm.local"`
Expected: FAIL — `cfg.localRoutes` is `undefined`.

- [ ] **Step 3: Implement**

`accumulateServiceTables` / `resolveServiceTableId` in `config/service-config-toml.ts` are module-private. Export them from there (they are pure and already tested) and import into `nimbus-toml.ts` with `LLM_LOCAL_TABLE_PREFIX = "[llm.local."`, rather than writing a second copy. Add `localRoutes` and `routePriority` to `NimbusLlmToml` and `DEFAULT_NIMBUS_LLM_TOML` (empty map, empty array). Validate every `routePriority` entry through `parseRouteRef`, and reject duplicate `llamacpp` `base_url`s.

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/src/config/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts \
        packages/gateway/src/config/service-config-toml.ts
git commit -m "feat(config): [llm.local.<name>] routes and route_priority"
```

---

### Task 9: Wire N routes at assembly

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts:1277-1311`
- Test: `packages/gateway/test/integration/llm-routes.integration.test.ts` **(new)**

**Interfaces:**

- Consumes: `NimbusLlmToml.localRoutes` (Task 8), `LlmRegistry.addRoute` (Task 6).
- Produces: a registry whose `routes()` reflects config.

- [ ] **Step 1: Write the failing test**

An integration test writing a real `nimbus.toml` to a temp dir and asserting `buildLlmRegistryFromToml` produces two routes. **Place it under `packages/gateway/test/integration/`** — and note that tree is NOT loaded by `bun test packages/gateway/src`, so run the CI command to see it. Use `os.tmpdir()` + `path.join`, never a hardcoded separator.

Assert: two `[llm.local.*]` entries → two routes; a config with only legacy `local_model` → exactly one Ollama route plus the llama.cpp route, matching today's behaviour.

- [ ] **Step 2: Run it and verify it fails**

Run: `bun test packages/gateway/test/integration/llm-routes.integration.test.ts`
Expected: FAIL — one route per runtime regardless of config.

- [ ] **Step 3: Implement**

In `buildLlmRegistryFromToml`, when `localRoutes` is non-empty, register one route per entry, constructing `OllamaProvider(baseUrl ?? "http://127.0.0.1:11434", model, llmToml.localContextTokens)` or `LlamaCppProvider(baseUrl, model)` by `runtime`. When it is empty, register exactly today's two providers via `addRoute(provider, llmToml.localModel)` so behaviour is unchanged. Keep the fire-and-forget `refreshProviderMeta` call, now iterating routes.

**Then the validation stage that Task 8 deliberately does not perform.** It lives here because a
throw inside the parser is swallowed by `loadTomlSection`'s bare catch and silently reverts the
whole `[llm]` section to defaults — including `enforce_air_gap`.

Resolve base URLs **before** comparing them, per review item 2.3 — two routes that both omit
`base_url` resolve to the same default and collide, which a raw-string comparison misses because
both values are `undefined`:

```ts
const LLAMACPP_DEFAULT_BASE_URL = "http://127.0.0.1:8080";

function resolveBaseUrl(runtime: string, baseUrl: string | undefined): string {
  const explicit = baseUrl?.trim() ?? "";
  if (explicit !== "") return explicit.replace(/\/$/, "");
  return runtime === "llamacpp" ? LLAMACPP_DEFAULT_BASE_URL : "http://127.0.0.1:11434";
}
```

Two rules, each logging the offending entry by name and **omitting only that entry**:

1. **A `llamacpp` resolved base URL claimed twice is an error.** `LlamaCppProvider.generate()`
   sends no model field — the server answers with whatever weights it was launched with — so two
   llama.cpp routes at one URL report different model names while hitting identical weights: a
   route table that lies. Keep the first, drop the rest, log both names and the URL. Ollama is
   exempt: `generate()` sends `this.modelName` to a shared daemon, so many routes at one base URL
   is the normal case.
2. **A `route_priority` entry that fails `parseRouteRef` or names no registered route is dropped
   with an explicit log line** naming the entry. It must not be silent — a vanished priority entry
   changes which model answers with no outward sign.

Neither rule aborts boot. The gateway starts with a correct-but-reduced route table and a loud
log, which is the same posture `refreshProviderMeta` takes when a provider is down.

Add to the integration test:

```ts
test("two llamacpp routes that BOTH omit base_url collide and one is dropped", () => {
  // The case a raw-string comparison misses: both values are `undefined`.
  writeConfig(`
[llm.local.a]
runtime = "llamacpp"
model = "a.gguf"

[llm.local.b]
runtime = "llamacpp"
model = "b.gguf"
`);
  const registry = buildLlmRegistryFromToml(db, tomlPath);
  const llamacpp = registry.llmRouter.routes().filter((r) => r.provider.providerId === "llamacpp");
  expect(llamacpp).toHaveLength(1);
});

test("many ollama routes on one base URL are all kept", () => {
  // Ollama sends the model name per request, so sharing a daemon is correct.
  writeConfig(`
[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"

[llm.local.gemma]
runtime = "ollama"
model = "gemma3:12b"
`);
  const registry = buildLlmRegistryFromToml(db, tomlPath);
  expect(registry.llmRouter.routes()).toHaveLength(2);
});

test("an unresolvable route_priority entry is dropped, and the rest of [llm] survives", () => {
  writeConfig(`
[llm]
enforce_air_gap = true
route_priority = ["ollama/nope", "ollama/qwen3:8b"]

[llm.local.qwen3]
runtime = "ollama"
model = "qwen3:8b"
`);
  const registry = buildLlmRegistryFromToml(db, tomlPath);
  // The security-relevant key MUST survive a bad neighbour — this is the regression
  // guard for loadTomlSection's swallow-and-revert behaviour.
  expect(registry.llmRouter.enforcesAirGap()).toBe(true);
  expect(registry.llmRouter.routes()).toHaveLength(1);
});
```

- [ ] **Step 4: Run the CI command**

Run: `bun test packages/gateway packages/cli scripts`
Expected: PASS. This is the first task where a `src`-only run would miss the new test.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts packages/gateway/test/integration/llm-routes.integration.test.ts
git commit -m "feat(llm): assemble registers one route per configured model"
```

---

### Task 10: IPC surface + the one-definition test

**Files:**

- Modify: `packages/gateway/src/ipc/llm-rpc.ts:20-28`
- Test: `packages/gateway/src/ipc/llm-rpc.test.ts`
- Test: `packages/gateway/src/llm/local-definition.test.ts` **(new)**

**Interfaces:**

- Consumes: everything above.
- Produces: `llm.status` returns `{ routes: Array<{ routeId, providerId, modelName, isLocal, available, reason, contextWindow }> }`. No new method.

- [ ] **Step 1: Write the failing tests**

The one-definition structural test (spec Open decision 1 — a test, not a `D`-rule):

```ts
import { describe, expect, test } from "bun:test";

const FILES = [
  "packages/gateway/src/llm/router.ts",
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/ipc/llm-rpc.ts",
];

describe("local-ness has exactly one definition", () => {
  test("no file re-derives the local provider set from literals", async () => {
    const offenders: string[] = [];
    for (const f of FILES) {
      const src = await Bun.file(f).text();
      // The three copies this refactor collapsed: a literal pair of local ids.
      if (/\["ollama",\s*"llamacpp"\]/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test("isLocal is read from the provider, never inferred from an id", async () => {
    const src = await Bun.file("packages/gateway/src/llm/router.ts").text();
    expect(src).not.toContain("LOCAL_PROVIDER_IDS");
  });
});
```

Plus an `llm-rpc` test asserting `llm.status` lists every route and that an absent-model route reports its reason.

- [ ] **Step 2: Run and verify they fail**

Run: `bun test packages/gateway/src/llm/local-definition.test.ts`
Expected: FAIL — `llm-rpc.ts` still contains `["ollama", "llamacpp"]` as `LOCAL_PROVIDERS`.

- [ ] **Step 3: Implement**

Delete `VALID_LLM_PROVIDERS`, `LOCAL_PROVIDERS`, `LocalProvider` and `requireLocalProvider`. `requireModelParams` accepts any non-empty `provider` string and defaults to `"ollama"`; validity is the registry's answer (`Provider not registered`), not a hardcoded set. Reshape `llm.status` to the route list. **Do not add a method** — the eight allowlisted `llm.*` names stay exactly as they are.

- [ ] **Step 4: Run the CI command + full preflight**

```bash
bun test packages/gateway packages/cli scripts
bun run preflight:fast
bun run typecheck && bun run typecheck:tests
```

Expected: all PASS. `typecheck:tests` is **advisory on win32** — it prints violations and exits 0 — and is Linux-authoritative, so a clean local run is not proof. Confirm with `bun run verify:docker --changed`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/llm-rpc.ts packages/gateway/src/ipc/llm-rpc.test.ts \
        packages/gateway/src/llm/local-definition.test.ts
git commit -m "refactor(ipc): llm.status lists routes; drop the last local-id copy"
```

---

### Task 11: Coverage floor, docs, and the deprecated alias

**Files:**

- Modify: `packages/gateway/src/llm/types.ts` (delete the `LlmProviderKind` alias)
- Modify: `docs/architecture.md` (LLM routing section)
- Modify: `docs/CHANGELOG.md` (dated entry)

- [ ] **Step 1: Remove the migration shims**

Delete the `LlmProviderKind` deprecated alias and `LlmRouter.registerProvider`. Run `bun run typecheck` and fix every resulting error — if any remain, a call site was missed in Tasks 3–10.

- [ ] **Step 2: Run the Linux-authoritative coverage floor**

Run: `bun run verify:docker --changed`
Expected: PASS. `llm/` is under the Engine ≥85% gate; new files must clear ≥85% line and ≥80% branch. A narrow run cannot reproduce cross-file `mock.module` contamination, so green here is evidence about these files, not the suite.

- [ ] **Step 3: Update the docs**

`docs/architecture.md`: the LLM section describing provider kinds. `docs/CHANGELOG.md`: a dated entry at the top of "Post-Phase-6 deliveries" stating what shipped **and what did not** — no cloud vendor, no per-task CLI, and that the egress-destination and overflow fixes are unit-proven only because no remote route exists yet.

- [ ] **Step 4: Full preflight**

```bash
bun run preflight
```

Expected: PASS.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -u
git commit -m "docs: record model-routes delivery and its bounds"
git push -u origin dev/asaf/llm-model-routes
```

PR title must carry the conventional-commit type — it is what release-please parses, and the squash commit is built from the PR title and body, not from these commit messages. Suggested: `feat(llm)!: route the LLM by (provider, model) instead of provider kind`. Check the body for unbalanced parentheses before opening; that has broken release-please three times.

---

## Self-Review

**Spec coverage:** §3.1 → Tasks 1, 2, 3. §3.2 → Tasks 1, 10. §3.3 → Task 3. §3.4 → Task 5. §3.5 → Task 6. §3.6 → Task 8. §3.7 (no migration) → Global Constraints. §4.1 → Task 4. §4.2 → Task 7. §6 testing → distributed. Open decision 1 (test not `D`-rule) → Task 10. Open decision 2 (`llm status`) → Task 10. Open decisions 3–4 are slice 2, correctly absent.

**Known gap, stated rather than hidden:** the spec's §3.3 task-pin gating is only partially exercised — `llm_task_defaults` pins have no surface until slice 4, so Task 3 implements the ordering and Task 4 tests the air-gap gate, but no test pins a task through config. The `enforceAirGap` route test covers the security property; the pin path is covered when slice 4 gives it an entry point.

**Type consistency:** `ProviderId` (Task 1) is used in Tasks 6, 7. `ModelRoute` (Task 1) in Tasks 3, 4, 5, 6. `makeRouteId`/`parseRouteRef` (Task 2) in Tasks 3, 8. `registerRoute` (Task 3) / `addRoute` (Task 6) are deliberately different names — router-level vs registry-level, matching the existing `registerProvider`/`addProvider` split. `RouteAvailability` (Task 5) in Task 10's status shape.
