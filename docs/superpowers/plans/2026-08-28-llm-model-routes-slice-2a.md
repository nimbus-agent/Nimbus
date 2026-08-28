# LLM Model Routes — Slice 2a (Coverage) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every non-local LLM route append an `egress_ledger` row by construction, close the `runTurn` air-gap bypass, and land invariant I34 — all before any cloud vendor is registered.

**Architecture:** A `wrapLedgeredProvider(db, provider, modelName)` decorator applied at `LlmRegistry.addRoute` returns local providers unchanged and wraps non-local ones so `generate()` appends one ledger row before delegating, fail-closed. This replaces the call-site append in `agents/_lib/synthesis-llm.ts`, so there is exactly one appender for the `model` class. A static D-rule confines `LlmRouter.registerRoute` to `llm/registry.ts` so no future code can enter the route table unwrapped.

**Tech Stack:** Bun v1.2+, TypeScript 7.x strict (no `any`), `bun:sqlite`, `bun:test`, Biome.

**Spec:** [`docs/superpowers/specs/2026-08-28-llm-model-routes-slice-2-design.md`](../specs/2026-08-28-llm-model-routes-slice-2-design.md) — §4 defines this PR as 2a. Read §5, §6.1, §8, §11 before starting. Review responses: [`…-design-review.md`](../specs/2026-08-28-llm-model-routes-slice-2-design-review.md).

## Global Constraints

- **No cloud vendor is registered in this PR.** Not one. Every remote behaviour is proven against a fake `isLocal: false` provider constructed in-test. If you find yourself adding an adapter file, you are in 2b and this plan does not cover it.
- **No `any`.** Use `unknown` for external data. TypeScript strict mode is non-negotiable.
- **Branch:** `dev/asaf/llm-model-routes-slice-2` (already created, already holds the spec commits). Never commit on `main`.
- **`appendEgressEntry` may only be named inside `packages/gateway/src/egress/`** — static rule D22, `scripts/structure-audit/check-nimbus-invariants.ts:803-804`. This is why the wrapper lives in `egress/`, not `llm/`.
- **Squash is the only merge method**, so the whole PR becomes one commit. The invariant "triple rule" (wiring + docs + test in one commit) is satisfied at PR level; per-task local commits are fine.
- **Cross-platform:** build paths with `path.join()` / `os.tmpdir()`. Never hardcode separators.
- **Per-task gate** (the whole-repo suite exceeds the 600s tool cap and cannot gate a task): `bun run typecheck` + scoped `bun test <paths>`. The wide suite runs once, in Task 7.
- **Editor diagnostics in this checkout are frequently stale.** Verify with real commands only.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `packages/gateway/src/engine/run-conversational-agent.ts` | Modify: refuse the Mastra fallback under air-gap | 1 |
| `packages/gateway/src/engine/run-conversational-agent.test.ts` | Modify: air-gap fallback test + stub repair | 1 |
| `packages/gateway/src/llm/types.ts` | Modify: add `egressMethod?` to `LlmGenerateOptions` | 2 |
| `packages/gateway/src/egress/model-egress.ts` | **Create**: `wrapLedgeredProvider`, `EgressAppendFailedError` — the sole `model`-class appender | 2 |
| `packages/gateway/src/egress/model-egress.test.ts` | **Create**: wrapper unit tests | 2 |
| `packages/gateway/src/llm/registry.ts` | Modify: wrap in `addRoute` | 3 |
| `packages/gateway/src/llm/router.ts` | Modify: `generateMarkdown` forwards `egressMethod` | 3 |
| `packages/gateway/src/agents/_lib/synthesis-llm.ts` | Modify: drop the call-site append + DI seam; map `EgressAppendFailedError` | 3 |
| `packages/gateway/src/egress/synthesis-egress.ts` | **Delete** — superseded by `model-egress.ts` | 3 |
| `scripts/structure-audit/check-nimbus-invariants.ts` | Modify: D-rule confining `registerRoute` | 4 |
| `packages/gateway/src/security-invariants.test.ts` | Modify: I34 block + I29 wrapper assertions | 4, 5 |
| `docs/SECURITY-INVARIANTS.md` | Modify: I34 row, I29 widening, ceiling | 5, 6 |
| `CLAUDE.md`, `GEMINI.md`, + 7 more ceiling sites | Modify: I33 → I34 | 5 |
| `packages/gateway/src/egress/egress-coverage.ts` | Modify: `model` class docstring | 6 |
| `packages/cli/src/commands/prove.ts` | Modify: `model` scope label | 6 |

---

### Task 1: Close the `runTurn` air-gap bypass

Spec §2.3 and §6.1. This is a live bug on `main` today, independent of everything else in this PR. Under `enforce_air_gap = true` with `prefer_local = true`, a local router that throws mid-turn falls through to the Mastra agent — which talks to Anthropic — with no air-gap check and no ledger row.

**Files:**

- Modify: `packages/gateway/src/engine/run-conversational-agent.ts:211-216`
- Test: `packages/gateway/src/engine/run-conversational-agent.test.ts`

**Interfaces:**

- Consumes: `LlmRouter.enforcesAirGap(): boolean` (already exists, `llm/router.ts`).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/engine/run-conversational-agent.test.ts`, inside the same `describe` that holds the existing `throwingRouter` test (~line 655). Mirror that fixture exactly — note it adds `enforcesAirGap`, which the existing stubs lack:

```ts
test("air-gap refuses the Mastra fallback when the local router throws", async () => {
  // #1334's shape: `enforce_air_gap` is a REFUSAL setting, so a local model dying
  // mid-turn must surface the failure, never downgrade to a cloud vendor. Counting
  // agent invocations is the assertion that matters -- "an error was returned" would
  // also pass if the agent ran first and then something else threw.
  const throwingRouter = {
    generate: mock(async () => {
      throw new Error("ollama down");
    }),
    prefersLocal: () => true,
    enforcesAirGap: () => true,
  } as unknown as LlmRouter;
  const agentGenerate = mock(async () => ({ text: "leaked to the cloud" }));
  const agent = { generate: agentGenerate } as unknown as Agent;

  await expect(
    runConversationalAgent({
      agent,
      llmRouter: throwingRouter,
      input: "which deployments had no downstream incident?",
      stream: false,
      sendChunk: () => undefined,
    }),
  ).rejects.toThrow("ollama down");

  expect(agentGenerate).toHaveBeenCalledTimes(0);
});

test("without air-gap the Mastra fallback still runs", async () => {
  // The guard must be air-gap-specific, not a blanket removal of the fallback.
  const throwingRouter = {
    generate: mock(async () => {
      throw new Error("ollama down");
    }),
    prefersLocal: () => true,
    enforcesAirGap: () => false,
  } as unknown as LlmRouter;
  const agentGenerate = mock(async () => ({ text: "answered by the agent" }));
  const agent = { generate: agentGenerate } as unknown as Agent;

  const r = await runConversationalAgent({
    agent,
    llmRouter: throwingRouter,
    input: "which deployments had no downstream incident?",
    stream: false,
    sendChunk: () => undefined,
  });

  expect(r.reply).toBe("answered by the agent");
  expect(agentGenerate).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run the tests to verify the first one fails**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts -t "air-gap refuses"`

Expected: FAIL. The promise resolves instead of rejecting, and `agentGenerate` was called once — the prompt reached the Mastra agent under air-gap. That failure *is* the bug.

- [ ] **Step 3: Add the guard**

In `packages/gateway/src/engine/run-conversational-agent.ts`, in `runTurn`'s catch (currently lines 211-216):

```ts
    } catch (e) {
      if (p.agent === undefined) {
        throw e;
      }
      // `enforce_air_gap` is a REFUSAL, not a preference (see `LlmRouter.enforcesAirGap`).
      // Falling back to the Mastra agent here would send the prompt to a cloud vendor --
      // outside the route table, so outside the I29 wrapper too, meaning not even a ledger
      // row would record it. Surface the local failure instead.
      if (llmRouter.enforcesAirGap()) {
        throw e;
      }
      conversationalLog.warn({ err: e }, "local LLM router failed; falling back to agent");
    }
```

- [ ] **Step 4: Run the tests to verify both pass**

Run: `bun test packages/gateway/src/engine/run-conversational-agent.test.ts`

Expected: both new tests PASS.

- [ ] **Step 5: Repair every stub the new call breaks**

`llmRouter.enforcesAirGap()` now runs on the catch path, and several existing fixtures build routers with `as unknown as LlmRouter` and no `enforcesAirGap` — that cast silences the compiler, so the failure appears only at runtime, and only on tests that reach the catch.

Run the file's full suite (Step 4 already did) and also:

Run: `bun test packages/gateway/src/engine packages/gateway/src/llm`

For any failure reading `enforcesAirGap is not a function`, add `enforcesAirGap: () => false` to that stub. Do **not** change the production line to `enforcesAirGap?.()` — an optional call would let a real router missing the method silently behave as air-gap-off, which is the wrong failure direction for a refusal setting.

- [ ] **Step 6: Red-prove by reverting**

Comment out the two-line `if (llmRouter.enforcesAirGap()) { throw e; }` guard, re-run
`bun test packages/gateway/src/engine/run-conversational-agent.test.ts -t "air-gap refuses"`,
confirm it FAILS, then restore the guard and confirm it passes. A guard that was never observed failing is not known to be load-bearing.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/engine/run-conversational-agent.ts packages/gateway/src/engine/run-conversational-agent.test.ts
git commit -m "fix(engine): refuse the Mastra fallback under air-gap"
```

---

### Task 2: The ledgered provider wrapper

Spec §5.1. Creates the appender but does **not** wire it — `addRoute` is untouched until Task 3, so this task is pure unit work with no production behaviour change.

**Files:**

- Create: `packages/gateway/src/egress/model-egress.ts`
- Create: `packages/gateway/src/egress/model-egress.test.ts`
- Modify: `packages/gateway/src/llm/types.ts` (add `egressMethod?` to `LlmGenerateOptions`)

**Interfaces:**

- Consumes: `appendEgressEntry(db, entry: EgressEntry)` from `egress/egress-ledger.ts`; `redactEgressSummary(payload: unknown): string` from `egress/egress-record.ts`; `LlmProvider`, `LlmGenerateOptions`, `LlmGenerateResult` from `llm/types.ts`.
- Produces, relied on by Tasks 3-5:
  - `wrapLedgeredProvider(db: Database, provider: LlmProvider, modelName: string, now?: () => number): LlmProvider`
  - `class EgressAppendFailedError extends Error` with a `cause: unknown` field
  - `LlmGenerateOptions.egressMethod?: string`

- [ ] **Step 1: Add the `egressMethod` field**

In `packages/gateway/src/llm/types.ts`, extend `LlmGenerateOptions`:

```ts
export type LlmGenerateOptions = {
  task: LlmTaskType;
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  onToken?: (token: string) => void;
  /**
   * The `method` this call records in `egress_ledger` when it reaches a NON-LOCAL route.
   * Omitted, the wrapper derives `llm.generate.<task>`.
   *
   * It exists so a synthesized brief keeps naming ITS OWN kind
   * (`agents.catchup.synthesis`) after the append moved off the synthesis call site and
   * into `egress/model-egress.ts`. Without it every model row would read
   * `llm.generate.reasoning` and `nimbus prove` could no longer say which brief sent what.
   *
   * It does NOT control WHETHER a row is appended -- that is derived from
   * `provider.isLocal` inside the wrapper and is not something a caller can influence.
   */
  egressMethod?: string;
};
```

- [ ] **Step 2: Write the failing tests**

Create `packages/gateway/src/egress/model-egress.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "../llm/types.ts";
import { EgressAppendFailedError, wrapLedgeredProvider } from "./model-egress.ts";

// The real ledger table, not a fake: `appendEgressEntry` computes a BLAKE3 chain over
// prior rows, so a stub db would not exercise the code path that actually runs.
function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE egress_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_id TEXT,
    destination TEXT NOT NULL,
    method TEXT NOT NULL,
    payload_summary TEXT NOT NULL,
    hitl_status TEXT NOT NULL,
    result_status TEXT NOT NULL,
    row_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL
  )`);
  return db;
}

function rows(db: Database): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM egress_ledger ORDER BY id").all() as Array<
    Record<string, unknown>
  >;
}

function makeProvider(providerId: string, isLocal: boolean): LlmProvider & {
  generate: ReturnType<typeof mock>;
} {
  const generate = mock(
    async (opts: LlmGenerateOptions): Promise<LlmGenerateResult> => ({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "m",
      isLocal,
      provider: providerId,
    }),
  );
  return {
    providerId,
    isLocal,
    isAvailable: async () => true,
    listModels: async () => [],
    generate,
  } as LlmProvider & { generate: ReturnType<typeof mock> };
}

describe("wrapLedgeredProvider", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("a LOCAL provider is returned unchanged and appends nothing", async () => {
    // Identity, not a pass-through wrapper: a local generate makes no outbound request,
    // so ledgering it would over-claim egress the way an unfiltered
    // LOCAL_ONLY_SYNC_SERVICES did. Not even a blocked row.
    const inner = makeProvider("ollama", true);
    const wrapped = wrapLedgeredProvider(db, inner, "qwen3:8b");

    expect(wrapped).toBe(inner);

    await wrapped.generate({ task: "reasoning", prompt: "hi" });
    expect(rows(db)).toHaveLength(0);
  });

  test("a REMOTE provider appends exactly one row, destination = providerId", async () => {
    // #1321's lesson: "email" is not a place data can go, "gmail" is. The destination
    // must name the vendor, never the word "model".
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6", () => 1234);

    await wrapped.generate({ task: "reasoning", prompt: "hi" });

    const r = rows(db);
    expect(r).toHaveLength(1);
    expect(r[0]?.["source_type"]).toBe("model");
    expect(r[0]?.["destination"]).toBe("anthropic");
    expect(r[0]?.["source_id"]).toBe("claude-sonnet-4-6");
    expect(r[0]?.["method"]).toBe("llm.generate.reasoning");
    expect(r[0]?.["timestamp"]).toBe(1234);
    expect(r[0]?.["result_status"]).toBe("authorized");
  });

  test("egressMethod overrides the derived method", async () => {
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    await wrapped.generate({
      task: "reasoning",
      prompt: "hi",
      egressMethod: "agents.catchup.synthesis",
    });

    expect(rows(db)[0]?.["method"]).toBe("agents.catchup.synthesis");
  });

  test("egressMethod cannot suppress a row for a remote provider", async () => {
    // The field names the row; it never decides whether one exists. Locality is derived
    // from the provider, so no caller can write a false zero into the ledger.
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    await wrapped.generate({ task: "reasoning", prompt: "hi", egressMethod: "" });

    expect(rows(db)).toHaveLength(1);
  });

  test("fail-closed: an append failure throws and the delegate never runs", async () => {
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");
    db.exec("DROP TABLE egress_ledger");

    await expect(wrapped.generate({ task: "reasoning", prompt: "hi" })).rejects.toBeInstanceOf(
      EgressAppendFailedError,
    );
    expect(inner.generate).toHaveBeenCalledTimes(0);
  });

  test("the wrapper is a faithful proxy of providerId and isLocal", async () => {
    // `byPreference`, `reasonFor`, `getStatus` and `ipc/llm-rpc.ts` all read these off the
    // route's provider. A wrapper that dropped or inverted them would silently re-sort the
    // priority walk and mislabel every status row.
    const inner = makeProvider("anthropic", false);
    const wrapped = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");

    expect(wrapped.providerId).toBe("anthropic");
    expect(wrapped.isLocal).toBe(false);
    expect(await wrapped.isAvailable()).toBe(true);
    expect(await wrapped.listModels()).toEqual([]);
  });

  test("wrapping is idempotent-safe: re-wrapping an already-wrapped provider double-counts", async () => {
    // Documents WHY `addRoute` wraps and `registerRoute` does not (Task 3). If a future
    // change moved the wrap into `registerRoute`, `refreshProviderMeta`'s re-registration
    // would wrap the wrapper and every generate would append twice. This test pins the
    // hazard so that change fails loudly here rather than silently in the ledger.
    const inner = makeProvider("anthropic", false);
    const once = wrapLedgeredProvider(db, inner, "claude-sonnet-4-6");
    const twice = wrapLedgeredProvider(db, once, "claude-sonnet-4-6");

    await twice.generate({ task: "reasoning", prompt: "hi" });
    expect(rows(db)).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/egress/model-egress.test.ts`

Expected: FAIL — `Cannot find module './model-egress.ts'`.

- [ ] **Step 4: Write the implementation**

Create `packages/gateway/src/egress/model-egress.ts`:

```ts
// packages/gateway/src/egress/model-egress.ts

import type { Database } from "bun:sqlite";
import type { LlmGenerateOptions, LlmGenerateResult, LlmProvider } from "../llm/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";

/**
 * Thrown when the ledger append fails. Distinct from a provider error ON PURPOSE:
 * `agents/_lib/synthesis-llm.ts` maps it back to the `egress_append_failed` outcome, which
 * travels to the user on the `briefReady` notification as `SynthesisProvenance`. Folding it
 * into `provider_error` would send someone to look at their model configuration for a
 * database problem.
 */
export class EgressAppendFailedError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super("egress ledger append failed");
    this.name = "EgressAppendFailedError";
    this.cause = cause;
  }
}

/**
 * The `model` class appender, and the ONLY one. Supersedes `recordSynthesisEgress`, whose
 * rationale this comment carries forward in full.
 *
 * `"model"` was already a FROZEN `EGRESS_SOURCE_TYPES` member reserved for exactly this
 * ("inference + embeddings, local or remote"). Do not add a source type.
 *
 * WHY IT WRAPS THE PROVIDER RATHER THAN LIVING AT A CALL SITE. `LlmRouter.generate()` is not
 * a chokepoint -- `briefs/brief-llm-adapter.ts` resolves a provider through
 * `selectProvider()` and calls `provider.generate()` directly, and it has a remote arm. An
 * append placed in the router method would have covered one of the two reachable remote
 * paths and left the other silent. Wrapping the provider INSTANCE covers `router.generate`,
 * `generateMarkdown`, every `selectProvider()` caller, and every caller written later,
 * without any of them cooperating. Same shape as `wrapServerSpec()` (I15 / static D10).
 *
 * WHY LOCALITY IS DERIVED HERE, NOT PASSED IN. A caller-supplied `remote` boolean is
 * unverifiable at the append site: passing `false` for a remote provider suppresses the row
 * and puts a FALSE ZERO in the ledger `nimbus prove` reports on; passing `true` for a local
 * one fabricates rows. Reading `provider.isLocal` makes both unrepresentable, so the
 * guarantee holds for a caller that never read this comment. `sync-egress.ts`'s
 * `recordSyncEgress` makes the same choice for `LOCAL_ONLY_SYNC_SERVICES`, for the same
 * reason.
 *
 * A LOCAL provider is returned UNCHANGED -- identity, not a pass-through wrapper. A local
 * generate makes no outbound request, so ledgering it would over-claim egress.
 *
 * WRAP AT `addRoute`, NEVER AT `registerRoute`. `LlmRegistry.refreshProviderMeta`
 * re-registers an existing route's provider through `registerRoute` to update its meta. That
 * provider is already wrapped, so wrapping inside `registerRoute` would wrap the wrapper and
 * every generate would append twice. Static rule D22(e) pins `registerRoute` to
 * `llm/registry.ts` so this stays true.
 */
export function wrapLedgeredProvider(
  db: Database,
  provider: LlmProvider,
  modelName: string,
  now: () => number = Date.now,
): LlmProvider {
  if (provider.isLocal) {
    return provider;
  }
  const pullModel = provider.pullModel?.bind(provider);
  return {
    providerId: provider.providerId,
    isLocal: provider.isLocal,
    isAvailable: () => provider.isAvailable(),
    listModels: () => provider.listModels(),
    ...(pullModel === undefined ? {} : { pullModel }),
    generate: async (opts: LlmGenerateOptions): Promise<LlmGenerateResult> => {
      // Ledger THEN act. An append that throws aborts the call, so a window with no rows
      // means no prompt left the machine -- never that one left unrecorded.
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: modelName,
          destination: provider.providerId,
          method: opts.egressMethod ?? `llm.generate.${opts.task}`,
          payloadSummary: redactEgressSummary({ model: modelName, task: opts.task }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err);
      }
      return provider.generate(opts);
    },
  };
}
```

- [ ] **Step 5: Run the tests and the typecheck**

Run: `bun test packages/gateway/src/egress/model-egress.test.ts && bun run typecheck`

Expected: all 7 tests PASS; typecheck clean.

- [ ] **Step 6: Red-prove the locality derivation**

Temporarily change `if (provider.isLocal)` to `if (false)` and re-run. Expected: the "LOCAL provider is returned unchanged" test FAILS on both assertions. Restore it. Then temporarily move the `appendEgressEntry` call to *after* `provider.generate(opts)` and re-run: expected the fail-closed test FAILS. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/egress/model-egress.ts packages/gateway/src/egress/model-egress.test.ts packages/gateway/src/llm/types.ts
git commit -m "feat(egress): add wrapLedgeredProvider, the sole model-class appender"
```

---

### Task 3: Wire the wrapper and retire the call-site append

Spec §5.4. After this task there is exactly one `model` appender in the tree.

**Files:**

- Modify: `packages/gateway/src/llm/registry.ts` (`addRoute`)
- Modify: `packages/gateway/src/llm/router.ts` (`generateMarkdown`)
- Modify: `packages/gateway/src/agents/_lib/synthesis-llm.ts`
- Delete: `packages/gateway/src/egress/synthesis-egress.ts` and `packages/gateway/src/egress/synthesis-egress.test.ts`
- Test: `packages/gateway/src/agents/_lib/synthesis-llm.test.ts`, `packages/gateway/src/llm/registry.test.ts`

**Interfaces:**

- Consumes: `wrapLedgeredProvider`, `EgressAppendFailedError`, `LlmGenerateOptions.egressMethod` (Task 2).
- Produces: `LlmRouter.generateMarkdown(prompt: string, resolved: ResolvedSynthesisProvider, egressMethod?: string): Promise<string>` — the third parameter is new. `SynthesisRouter.generateMarkdown` widens to match. `SynthesisLlmDeps.recordEgress` and the exported type `SynthesisEgressRecorder` are **removed**.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/llm/registry.test.ts`:

```ts
test("addRoute ledgers a remote route's generate exactly once", async () => {
  // The end-to-end shape of the wiring: registry -> router -> provider, one row.
  const db = freshLedgerDb(); // reuse this file's existing db helper; see note below
  const registry = new LlmRegistry({ db, config: DEFAULT_CONFIG });
  const remote = {
    providerId: "anthropic",
    isLocal: false,
    isAvailable: async () => true,
    listModels: async () => [{ provider: "anthropic", modelName: "claude-sonnet-4-6" }],
    generate: async () => ({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "claude-sonnet-4-6",
      isLocal: false,
      provider: "anthropic",
    }),
  } satisfies LlmProvider;

  registry.addRoute(remote, "claude-sonnet-4-6");
  await registry.llmRouter.generate({ task: "reasoning", prompt: "hi" });

  const n = db.query("SELECT COUNT(*) AS c FROM egress_ledger").get() as { c: number };
  expect(n.c).toBe(1);
});

test("refreshProviderMeta does not double-wrap", async () => {
  // `refreshProviderMeta` re-registers a route's provider through `registerRoute`. If the
  // wrap ever moved there, this would append two rows per generate.
  const db = freshLedgerDb();
  const registry = new LlmRegistry({ db, config: DEFAULT_CONFIG });
  const local = {
    providerId: "ollama",
    isLocal: true,
    isAvailable: async () => true,
    listModels: async () => [
      { provider: "ollama", modelName: "qwen3:8b", parameterCount: 8 },
    ],
    generate: async () => ({
      text: "ok",
      tokensIn: 1,
      tokensOut: 1,
      modelUsed: "qwen3:8b",
      isLocal: true,
      provider: "ollama",
    }),
  } satisfies LlmProvider;

  registry.addRoute(local, "qwen3:8b");
  await registry.refreshProviderMeta();
  expect(registry.llmRouter.routes()).toHaveLength(1);
});
```

If `registry.test.ts` has no ledger-backed db helper, add `freshLedgerDb()` to that file using the same `CREATE TABLE egress_ledger` DDL as `model-egress.test.ts` Step 2.

Add to `packages/gateway/src/agents/_lib/synthesis-llm.test.ts`:

```ts
test("a failed ledger append surfaces as egress_append_failed, not provider_error", async () => {
  // These two are kept apart because `detail` reaches the user on `briefReady`. Sending
  // someone to their model config for a database problem is a false diagnosis.
  const runner = buildSynthesisRunner({
    config: { synthesis: "allow-remote", synthesisTimeoutMs: 5_000 } as NimbusAgentsToml,
    router: {
      resolveForSynthesis: async () => ({
        providerId: "anthropic",
        modelName: "claude-sonnet-4-6",
        isLocal: false,
      }),
      generateMarkdown: async () => {
        throw new EgressAppendFailedError(new Error("table missing"));
      },
    },
    db: new Database(":memory:"),
    briefKind: "catchup",
    now: () => 0,
  });

  const out = await runner?.run("prompt");
  expect(out).toMatchObject({ ok: false, reason: "egress_append_failed" });
});

test("the synthesis call names its own brief kind as the ledger method", async () => {
  const seen: Array<string | undefined> = [];
  const runner = buildSynthesisRunner({
    config: { synthesis: "allow-remote", synthesisTimeoutMs: 5_000 } as NimbusAgentsToml,
    router: {
      resolveForSynthesis: async () => ({
        providerId: "anthropic",
        modelName: "claude-sonnet-4-6",
        isLocal: false,
      }),
      generateMarkdown: async (_p, _r, egressMethod) => {
        seen.push(egressMethod);
        return "# brief";
      },
    },
    db: new Database(":memory:"),
    briefKind: "catchup",
    now: () => 0,
  });

  await runner?.run("prompt");
  expect(seen).toEqual(["agents.catchup.synthesis"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/llm/registry.test.ts packages/gateway/src/agents/_lib/synthesis-llm.test.ts`

Expected: FAIL — the registry test appends 0 rows (no wrapping yet); the synthesis tests fail to compile or report `provider_error`.

- [ ] **Step 3: Wire `addRoute`**

In `packages/gateway/src/llm/registry.ts`, add the import and change `addRoute`:

```ts
import { wrapLedgeredProvider } from "../egress/model-egress.ts";
```

```ts
  /**
   * Registers a route under an explicit model name.
   *
   * Wrapping happens HERE and not in `LlmRouter.registerRoute`, because
   * `refreshProviderMeta` below re-registers an ALREADY-WRAPPED provider through
   * `registerRoute` to update its meta -- wrapping there would wrap the wrapper and append
   * two rows per generate. Static rule D22(e) pins `registerRoute` to this file so no other
   * caller can enter the route table unwrapped.
   */
  addRoute(provider: LlmProvider, modelName: string, meta?: ProviderMeta): void {
    this.router.registerRoute(
      wrapLedgeredProvider(this.db, provider, modelName),
      modelName,
      meta ?? {},
    );
  }
```

- [ ] **Step 4: Widen `generateMarkdown`**

In `packages/gateway/src/llm/router.ts`:

```ts
  async generateMarkdown(
    prompt: string,
    resolved: ResolvedSynthesisProvider,
    egressMethod?: string,
  ): Promise<string> {
    const route = this.routeFor(makeRouteId(resolved.providerId, resolved.modelName));
    if (route === undefined) {
      throw new Error(`LLM provider "${resolved.providerId}" is no longer registered`);
    }
    const result = await route.provider.generate({
      task: "reasoning",
      prompt,
      ...(egressMethod === undefined ? {} : { egressMethod }),
    });
    return result.text;
  }
```

- [ ] **Step 5: Retire the call-site append**

In `packages/gateway/src/agents/_lib/synthesis-llm.ts`:

- **(1)** Delete the `import { recordSynthesisEgress } ...` line, the `SynthesisEgressRecorder` type export, the `recordEgress?` field on `SynthesisLlmDeps`, and the `const recordEgress = deps.recordEgress ?? recordSynthesisEgress;` line.
- **(2)** Delete the whole `try { recordEgress(...) } catch { return { ok: false, reason: "egress_append_failed", ... } }` block.
- **(3)** Widen the `SynthesisRouter` interface:

```ts
export interface SynthesisRouter {
  resolveForSynthesis(preferLocal?: boolean): Promise<ResolvedSynthesisProvider | undefined>;
  generateMarkdown(
    prompt: string,
    provider: ResolvedSynthesisProvider,
    egressMethod?: string,
  ): Promise<string>;
}
```

- **(4)** Pass the brief kind and re-map the error:

```ts
      const raced = await raceWithTimeout(
        deps.router.generateMarkdown(prompt, resolved, `agents.${deps.briefKind}.synthesis`),
        deps.config.synthesisTimeoutMs,
      );
      if (raced.kind === "timeout") {
        return { ok: false, reason: "timeout" };
      }
      if (raced.kind === "error") {
        // The append moved into `egress/model-egress.ts` (it wraps the provider, so it
        // covers callers this file cannot see). Its failure now arrives as a rejection
        // rather than a local throw, so the distinct outcome is preserved by TYPE here.
        // Merging it into `provider_error` would send the user to their model config for
        // a database problem -- `detail` reaches them on `briefReady`.
        if (raced.error instanceof EgressAppendFailedError) {
          return { ok: false, reason: "egress_append_failed", detail: redactedErrorDetail(raced.error) };
        }
        return { ok: false, reason: "provider_error", detail: redactedErrorDetail(raced.error) };
      }
```

- **(5)** Update the numbered doc comment on `buildSynthesisRunner` — step 4 no longer describes a call-site append. Replace that paragraph with a pointer to `wrapLedgeredProvider`, and **keep** the "do not unify `generateMarkdown` with `generate()`" note: it is still correct, because `generate()` re-selects a route and would skip the `[agents] synthesis` mode check even though the ledger now covers both.

- [ ] **Step 6: Delete the superseded appender**

```bash
git rm packages/gateway/src/egress/synthesis-egress.ts packages/gateway/src/egress/synthesis-egress.test.ts
```

Then: `grep -rn "recordSynthesisEgress\|SynthesisEgressRecorder" --include=*.ts packages/ scripts/ | grep -v node_modules`

Expected: no matches. Any remaining hit is a caller that must be migrated, not deleted around.

- [ ] **Step 7: Run the scoped tests and typecheck**

Run: `bun test packages/gateway/src/llm packages/gateway/src/egress packages/gateway/src/agents && bun run typecheck`

Expected: PASS. Existing `synthesis-llm.test.ts` cases that injected `recordEgress` must be rewritten to assert on ledger rows through a wrapped provider instead — that DI seam is gone by design, and the wrapper is now the thing under test.

- [ ] **Step 8: Commit**

```bash
git add -u && git add packages/gateway/src
git commit -m "refactor(egress): move the model append from the synthesis call site into the provider wrapper"
```

---

### Task 4: Static rule D22(e) — confine `registerRoute`

Spec §5.3, Open decision 1's promotion. Written as *what cannot pass*, since an allow-list of known-good spellings fails silently when a new spelling appears.

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (near the D22 block, lines 789-816)
- Test: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: `checkEgressChokepointConfinement(files: readonly FileEntry[]): Violation[]` — the existing D22 checker, extended rather than duplicated.
- Produces: violations with `rule: "D22-register-route"`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/security-invariants.test.ts`, inside the existing `describe("I29 — egress-ledger completeness over the executor chokepoint")`:

```ts
  // The route table is the boundary the model-class appender sits on. A file that calls
  // `registerRoute` directly enters that table WITHOUT `addRoute`'s `wrapLedgeredProvider`,
  // so its provider would generate with no ledger row -- I29's `model` class silently
  // incomplete, with the static audit green.
  test("I29/D22(e): registerRoute is named only by registry.ts and its own definition", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bregisterRoute\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/llm/registry.ts",
      "packages/gateway/src/llm/router.ts",
    ]);
  });

  test("I29: the checker actually rejects an unwrapped route registration", () => {
    const violations = checkEgressChokepointConfinement([
      {
        relPath: "packages/gateway/src/platform/assemble.ts",
        contents: "router.registerRoute(provider, 'm');",
      },
    ]);
    expect(violations.map((v) => v.rule)).toContain("D22-register-route");
  });
```

Note the file paths use forward slashes because `f.rel` is normalised by `readDirFiles`; check that helper at line 80 and match its convention.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "D22(e)"`

Expected: the second test FAILS (`D22-register-route` is not among the rules — the checker does not know the rule yet).

- [ ] **Step 3: Extend the checker**

In `scripts/structure-audit/check-nimbus-invariants.ts`, after the `D22_AGENT_RECORD_DEFINITION` constant (~line 816):

```ts
// (e) the ROUTE-TABLE chokepoint. `LlmRegistry.addRoute` is where a provider is passed
// through `wrapLedgeredProvider` (the I29 `model`-class appender). A file that calls
// `LlmRouter.registerRoute` directly puts an UNWRAPPED provider in the route table, which
// then generates with no ledger row -- the `model` class silently incomplete while this
// audit stays green.
//
// `registry.ts` is permitted twice over: `addRoute` (which wraps) and `refreshProviderMeta`
// (which re-registers an ALREADY-wrapped provider to update its meta, and must NOT wrap
// again or every generate would append twice). `router.ts` holds the definition.
const D22_REGISTER_ROUTE_RE = /\bregisterRoute\b/;
const D22_REGISTER_ROUTE_ALLOWED: readonly string[] = [
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/llm/router.ts",
];
```

Then inside `checkEgressChokepointConfinement`'s per-line loop, alongside the existing three checks:

```ts
      if (
        D22_REGISTER_ROUTE_RE.test(line) &&
        !D22_REGISTER_ROUTE_ALLOWED.includes(f.relPath)
      ) {
        out.push({
          rule: "D22-register-route",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
```

Finally, extend the D22 error message at line ~1300 to name the new rule:

```ts
        `::error file=${e.file},line=${e.line}::D22 egress chokepoint breach (connectors.dispatch outside executor.ts, appendEgressEntry outside egress/, recordAgentBriefEgress outside agents-rpc.ts, or registerRoute outside llm/registry.ts) — bypasses I29: ${e.snippet}`,
```

- [ ] **Step 4: Run the audit and the tests**

Run: `bun run audit:invariants && bun test packages/gateway/src/security-invariants.test.ts`

Expected: audit exits 0 (the only production `registerRoute` sites are the two allowed files — `platform/assemble.ts:1372` names it inside a comment, which `stripComments` removes), and both tests PASS.

- [ ] **Step 5: Red-prove the rule**

Temporarily add `router.registerRoute(p, "m");` to `packages/gateway/src/platform/assemble.ts`, run `bun run audit:invariants`, confirm it FAILS naming `D22-register-route`, then remove the line and confirm it passes.

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/check-nimbus-invariants.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(audit): D22(e) confines registerRoute to the wrapping registry"
```

---

### Task 5: Invariant I34 — locality-declaration integrity

Spec §8. The triple: wiring already exists (`isLoopbackBaseUrl`), so this task adds the enforcement test and the docs row. **The ceiling update is not optional** — `scripts/structure-audit/check-status-drift.ts` derives the canonical highest invariant from `security-invariants.test.ts` and fails every doc that disagrees.

**Files:**

- Modify: `packages/gateway/src/security-invariants.test.ts` (new `describe` block)
- Modify: `docs/SECURITY-INVARIANTS.md` (new `## I34` section + ceiling line 3)
- Modify: the 8 other ceiling sites listed in Step 3

**Interfaces:**

- Consumes: `isLoopbackBaseUrl(baseUrl: string): boolean` from `llm/base-url-locality.ts`; `OllamaProvider`, `LlamaCppProvider`.
- Produces: nothing other tasks consume.

- [ ] **Step 1: Write the failing test**

Add a new top-level `describe` to `packages/gateway/src/security-invariants.test.ts`:

```ts
describe("I34 — locality is declared once, and a cloud adapter can never claim to be local", () => {
  // Air-gap refusal AND the I29 `model` appender both read `provider.isLocal`. A wrong
  // `true` is one word and silent in both directions: the prompt leaves under a setting
  // that promised it would not, and no ledger row records that it did.

  test("a local runtime pointed at a LAN box is NOT local", () => {
    // Slice 1's fix. `base_url` is user-configurable and `[llm.local.*]` accepts a remote
    // host, so a hardcoded `true` here defeated `enforce_air_gap` entirely.
    expect(new OllamaProvider("http://192.168.1.50:11434", "m").isLocal).toBe(false);
    expect(new LlamaCppProvider("http://192.168.1.50:8080", "m").isLocal).toBe(false);
  });

  test("a local runtime on loopback IS local", () => {
    expect(new OllamaProvider("http://127.0.0.1:11434", "m").isLocal).toBe(true);
    expect(new LlamaCppProvider("http://localhost:8080", "m").isLocal).toBe(true);
  });

  test("locality is derived from the base URL, never from a vendor id", async () => {
    // One definition site. Three copies of this fact is what produced the hardcoded-env
    // bug in the Windows sandbox work; `LOCAL_PROVIDER_IDS` and its two duplicates were
    // deleted in slice 1 and must not come back.
    const files = await readDirFiles("packages/gateway/src");
    const offenders = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /LOCAL_PROVIDER_IDS|LOCAL_PROVIDERS\s*=/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("isLoopbackBaseUrl has exactly one definition site", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const definers = files
      .filter((f) => /export function isLoopbackBaseUrl\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`);
    expect(definers).toEqual(["packages/gateway/src/llm/base-url-locality.ts"]);
  });
});
```

> **2b will add to this block**, not replace it: a case asserting each cloud adapter reports `isLocal === false` even when constructed with a loopback `base_url` (a proxy forwards to the vendor; locality there is hardcoded, not derived). Do not add that case now — there are no cloud adapters in 2a.

- [ ] **Step 2: Run the test**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I34"`

Expected: PASS (the wiring already exists — this task pins it). If the third or fourth test fails, a duplicate locality definition survived slice 1 and must be deleted before continuing.

- [ ] **Step 3: Update all nine ceiling sites**

`check-status-drift.ts` reads the highest `I<N>` in `security-invariants.test.ts` — now 34 — and fails any doc still claiming 33. Change each of these, in this commit:

| File | Line | Current text |
| --- | --- | --- |
| `docs/SECURITY-INVARIANTS.md` | 3 | `invariants I1–I33 (static rules D10–D23; …)` |
| `CLAUDE.md` | 8 | `Invariants through I33 (I28 reserved)` |
| `CLAUDE.md` | 187 | `I1–I33 rationale (I28 reserved)` |
| `GEMINI.md` | 8 | `Invariants through I33 (I28 reserved)` |
| `GEMINI.md` | 187 | `I1–I33 rationale (I28 reserved)` |
| `docs/architecture.md` | 5 | `Current invariants through I33 (I28 reserved)` |
| `docs/architecture.md` | 1793 | `currently **I1–I33**, with I28 reserved` |
| `docs/README.md` | 823 | `SECURITY-INVARIANTS.md# I1–I33 rationale` |
| `.github/SECURITY.md` | 4 | `invariant catalogue (I1–I33, with I28 reserved)` |
| `.claude/commands/nimbus-file-map.md` | 331 | `I1–I33 rationale (I28 reserved)` |
| `.claude/commands/nimbus-tool-output-envelope.md` | 104 | `every invariant (I1–I33; I28 reserved)` |

Replace `I33` with `I34` in each. The `D10–D23` range in `SECURITY-INVARIANTS.md:3` stays — I34 ships no new `D` number (Task 4's rule is D22(e), an extension of an existing rule).

Verify none were missed:

```bash
grep -rn "I1–I33\|I1-I33\|hrough I33" --include=*.md . | grep -v "^./.claude/worktrees/" | grep -v node_modules
```

Expected: only `docs/superpowers/specs/2026-08-28-llm-model-routes-slice-2-design.md`, which quotes the old string while describing the change.

- [ ] **Step 4: Write the I34 section**

Add to `docs/SECURITY-INVARIANTS.md`, after the `## I33` section, matching the surrounding sections' structure (statement, rationale, anti-patterns, wiring sites, enforcement test):

```markdown
## I34 — locality is declared once per adapter, and a cloud adapter can never claim to be local

**Statement.** Every `LlmProvider` declares `isLocal` from exactly one source: a local runtime
derives it from its resolved base URL via `llm/base-url-locality.ts` `isLoopbackBaseUrl`; a cloud
adapter hardcodes `false`. No code re-derives locality from a vendor id.

**Why it is numbered.** `isLocal` is the single field read by two independent defenses: air-gap
refusal (`LlmRouter.firstAvailableRoute` skips every non-local route under
`[llm] enforce_air_gap`) and the I29 `model`-class appender (`egress/model-egress.ts` appends only
for a non-local provider). A wrong `true` is one word and fails silently in both directions at
once — the prompt leaves the machine under a setting that promised it would not, and no ledger row
records that it did.

**Anti-patterns.**

- A hardcoded `isLocal = true` on a runtime whose base URL is user-configurable. This SHIPPED:
  `OllamaProvider` and `LlamaCppProvider` both declared `true` while `[llm.local.*]` accepted a
  LAN host, so `base_url = "http://192.168.1.50:8080"` survived `enforce_air_gap` and appended no
  ledger row. Fixed in slice 1 (PR #1352).
- Deriving a cloud adapter's locality from its base URL. The inverse mistake: pointing the
  Anthropic adapter at `http://127.0.0.1:4000` (a LiteLLM-style proxy) does not make the traffic
  local — the proxy forwards to Anthropic. Cloud adapters hardcode `false`.
- A second locality lookup keyed on `providerId`. Three copies of this fact existed before slice 1
  (`llm/router.ts`, `ipc/llm-rpc.ts`, `llm/registry.ts`) and had to agree.

**Wiring.** `llm/base-url-locality.ts` (the one definition), read off the provider instance
everywhere else.

**Enforcement test.** `packages/gateway/src/security-invariants.test.ts`,
`describe("I34 — locality is declared once…")`.
```

- [ ] **Step 5: Run the drift gate and the doc gates**

Run: `bun run audit:status-drift && bun run lint:markdown && bun run audit:doc-refs`

Expected: all exit 0. Then check for absolute links, which pass locally and fail lychee on CI:

```bash
grep -rn "file:///" --include=*.md docs/ *.md
```

Expected: only prose describing the check itself.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts docs/ CLAUDE.md GEMINI.md .github/SECURITY.md .claude/commands/
git commit -m "feat(security): add invariant I34, locality-declaration integrity"
```

---

### Task 6: Widen the I29 documentation to match the new wiring

Spec §12. Every restatement of the `model` class changes together — a claim corrected in one place and left stale in another is worse than one that was never corrected, because the stale copy now looks authoritative.

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (the I29 section, `model` coverage class)
- Modify: `packages/gateway/src/egress/egress-coverage.ts:82-95`
- Modify: `packages/cli/src/commands/prove.ts:62`
- Modify: `docs/CHANGELOG.md`, `docs/roadmap.md`

**Interfaces:** documentation only; no code contracts change.

- [ ] **Step 1: Fix the drifted docstring in `egress-coverage.ts`**

Line 88 still describes a mechanism slice 1 removed: *"enforced INSIDE the appender via a required `remote` argument"*. There is no `remote` argument — locality is derived from `provider.isLocal`. Rewrite the `model` paragraph:

```ts
 * `model` is `per-call` and covers every NON-LOCAL route in the router's table. The appender is
 * `egress/model-egress.ts`'s `wrapLedgeredProvider`, applied at `LlmRegistry.addRoute`, so it
 * covers `LlmRouter.generate()`, `generateMarkdown()`, and every `selectProvider()` caller
 * (`briefs/brief-llm-adapter.ts` among them) without any of them cooperating. The local-vs-remote
 * distinction is enforced INSIDE the wrapper, DERIVED from `provider.isLocal` -- a local provider
 * is returned unwrapped and appends nothing. Static rule D22(e) confines `registerRoute` to
 * `llm/registry.ts` so nothing enters the route table unwrapped.
 *
 * It is still NOT "all inference", and two exclusions remain. EMBEDDINGS APPEND NOTHING:
 * `PROSE_HEAVY_TYPES` routes to OpenAI's 1536-dim table when a key is set, and that path has no
 * appender -- a zero `model` count does NOT mean no vector left the machine. THE MASTRA ENGINE
 * AGENT APPENDS NOTHING in this slice: `engine/agent.ts` resolves its model through
 * `@mastra/core`, outside the route table entirely. Slice 2b brings it under a decorator at the
 * AI-SDK seam; until then it is an open, named gap. Raising this entry further requires landing
 * the embedding appender.
```

- [ ] **Step 2: Widen the `nimbus prove` scope label**

In `packages/cli/src/commands/prove.ts:62`, the label reads `"remotely-synthesized agent briefs"`. It now under-reports:

```ts
  // NOT "model calls". Covers every non-local ROUTE in the router's table (all callers, via
  // the provider wrapper). Embeddings and the Mastra engine agent append nothing -- see the
  // `model` entry in gateway egress-coverage.ts.
  model: "prompts sent to a non-local model route",
```

Check for a test asserting the old string:

```bash
grep -rn "remotely-synthesized agent briefs" --include=*.ts packages/ | grep -v node_modules
```

Update any hit in the same commit.

- [ ] **Step 3: Widen the I29 `model` paragraph in `docs/SECURITY-INVARIANTS.md`**

In the `## I29` section, replace the fourth-append-path paragraph describing `agents/_lib/synthesis-llm.ts` + `egress/synthesis-egress.ts` with the wrapper. State the same three facts as Step 1: the chokepoint is `wrapLedgeredProvider` at `addRoute`; locality is derived inside it; D22(e) confines `registerRoute`. Name both remaining exclusions (embeddings, the Mastra agent) explicitly — I29's existing exclusions are documented with that rigor and this one must match.

Also add, to the CLAUDE.md and GEMINI.md I29 bullet, a clause replacing the `agents/_lib/synthesis-llm.ts` / `egress/synthesis-egress.ts` file references with `egress/model-egress.ts`.

> **Leave the S2 status paragraph alone.** `CLAUDE.md:8` / `GEMINI.md:8` say `packages/gateway/src/llm/` "ships only `OllamaProvider` and `LlamaCppProvider` today, so the I29 `model` egress class is wired but appends zero rows in production". That is still TRUE after 2a — no vendor is registered. It becomes false in 2b, and 2b changes it.

- [ ] **Step 4: Add the CHANGELOG and roadmap entries**

`docs/CHANGELOG.md` is canonical and dated. Add an entry for 2026-08-28 covering: the wrapper chokepoint, the retired call-site appender, D22(e), I34, and the air-gap fix. In `docs/roadmap.md` § Active, note S2's model-routes row as slice 2a delivered with 2b (vendors) pending.

- [ ] **Step 5: Run the doc gates**

Run: `bun run lint:markdown && bun run audit:doc-refs && bun run audit:status-drift`

Expected: all exit 0.

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md packages/gateway/src/egress/egress-coverage.ts packages/cli/src/commands/prove.ts
git commit -m "docs: widen I29's model class to the provider-wrapper chokepoint"
```

---

### Task 7: Full verification

The per-task gate deliberately skipped the wide suite. `wrapLedgeredProvider`, `LlmGenerateOptions` and `LlmRouter.generateMarkdown` are all widely consumed, and slice 1 deferred a 10-test regression across 5 files by 5 tasks precisely by not doing this.

**Files:** none — verification only.

- [ ] **Step 1: The gateway `test/` tree**

Run: `bun test packages/gateway/test`

This tree is **not** loaded by a `packages/gateway/src` run, and `mock.module` is process-global, so a per-package run and a whole-repo run do not have the same mocks in play. Expected: PASS.

- [ ] **Step 2: The CI command, verbatim**

Run: `bun test packages/gateway packages/cli scripts`

Expected: PASS. This is the command the push matrix and the PR cross-platform legs both run. Do not substitute a narrower one.

- [ ] **Step 3: Typecheck both trees**

Run: `bun run typecheck && bun run typecheck:tests`

`typecheck:tests` is **advisory on win32** — it prints violations and exits 0. Read its output; do not trust its exit code. It is Linux-authoritative.

- [ ] **Step 4: The static gates**

Run: `bun run preflight:fast`

Expected: exit 0. Note this does **not** include the coverage floor.

- [ ] **Step 5: The Linux-authoritative checks**

Run: `bun run verify:docker --changed`

`audit:coverage-floor` is CI-Linux-authoritative and a local Windows run produces false violations. `llm/` and `egress/` sit under the Engine ≥85% gate; the new `model-egress.ts` must clear both the ≥85% line and ≥80% branch floors.

- [ ] **Step 6: Confirm no vendor leaked into this PR**

```bash
git diff main...HEAD --name-only | grep -E "anthropic-provider|openai-provider|gemini-provider|xai-provider|llm\.remote"
```

Expected: **no output**. Any hit means 2b work landed in 2a, which breaks the ordering §4 exists to enforce.

- [ ] **Step 7: Open the PR**

The PR title and body become the squash commit — a local commit message never reaches `main`. Title must carry the conventional-commit type for release-please:

```bash
gh pr create --title "feat(egress)!: ledger every non-local LLM route at the provider chokepoint" --body "$(cat <<'BODY'
Slice 2a of the LLM model routes work. Closes the three blockers slice 1 (#1352) named
before any remote route may register. Registers ZERO cloud vendors by design -- see
docs/superpowers/specs/2026-08-28-llm-model-routes-slice-2-design.md section 4 for why
the coverage fix must land first.

- wrapLedgeredProvider at LlmRegistry.addRoute is now the sole model-class appender,
  replacing the call site in synthesis-llm.ts. Covers router.generate, generateMarkdown
  and every selectProvider caller, including briefs/brief-llm-adapter.ts, which the
  originally-planned router-method append would have missed.
- Fixes a live air-gap bypass: under enforce_air_gap with prefer_local, a local router
  that threw fell through to the Mastra agent and reached Anthropic, unledgered.
- Adds invariant I34 (locality-declaration integrity) and static rule D22(e).

BREAKING CHANGE: LlmRouter.generateMarkdown takes an optional third parameter and
SynthesisLlmDeps.recordEgress is removed.

Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

Watch `PR quality — required gates` to green before merging, or use `gh pr merge --squash --auto`. Merging before green is the main cause of red `main`, and org-admin bypass is silent.

---

## Self-Review

**Spec coverage.** §5.1 → Task 2+3. §5.2 → Task 2 (docstring) + Task 4 (the rule that makes it structural). §5.3 → Task 4. §5.4 → Task 3, including the `egressMethod` field, the `EgressAppendFailedError` mapping, and the `generateMarkdown` widening the spec flagged as the one non-pass-through site. §6.1 → Task 1. §8 (I34) → Task 5. §11's 2a-scoped tests → Tasks 1-5; the two-row external-transport test and the local-passthrough test both appear. §12 → Task 6. §13's `mock.module` risk → the wrapper takes `db` explicitly, so every test injects rather than mocks.

**Deliberately not in this plan** (all 2b, per §4): the four adapters, `[llm.remote.*]`, the Vault keys, the Mastra unification, `nimbus llm status`, generate-time route fallback (§6.4), and the CLI shape-parity test.

**One spec item this plan resolves rather than carries.** §13 left the wrapper's file location open ("`egress/` or D22 widens deliberately"). D22 pins `appendEgressEntry` to `packages/gateway/src/egress/` (`check-nimbus-invariants.ts:803-804`), so `egress/model-egress.ts` is forced. No rule widening needed.

**One hazard found while planning, not in the spec.** `LlmRegistry.refreshProviderMeta` re-registers a route's provider through `registerRoute`. Wrapping in `addRoute` (not `registerRoute`) makes double-wrapping impossible by construction; Task 2 Step 2 pins the hazard with a test and Task 4's rule keeps the two entry points distinct.

**Type consistency.** `wrapLedgeredProvider(db, provider, modelName, now?)` is used with that arity in Tasks 2, 3 and the `registry.ts` wiring. `EgressAppendFailedError` is constructed in Task 2 and matched by `instanceof` in Task 3. `egressMethod` is defined in Task 2 Step 1, forwarded in Task 3 Step 4, and asserted in Task 2 and Task 3. `generateMarkdown`'s third parameter is added to both the class (Task 3 Step 4) and the `SynthesisRouter` interface (Task 3 Step 5).
