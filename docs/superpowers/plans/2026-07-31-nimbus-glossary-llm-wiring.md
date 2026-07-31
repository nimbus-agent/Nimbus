# Nimbus Glossary — LLM Wiring, Snippet Upgrades, Manual Refresh: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the scheduler-triggered glossary pass consolidate through a local LLM, let existing snippet definitions upgrade to LLM ones, and wire `nimbus glossary --refresh` / `--rebuild`.

**Architecture:** A `ConsolidatorLlm` adapter over the existing `LlmRouter` that hard-rejects non-local providers is injected into `createSchedulerWithMesh` and gated on a new `[glossary].use_llm`. `consolidatePhase` gains a second batch — consolidated-but-snippet-sourced terms — with a reserved slot floor so it can never starve. A new `glossary.*` IPC namespace drives on-demand passes through the existing refresher's single-flight guard, using `LongRunningJobRegistry` because a pass can run minutes.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, JSON-RPC 2.0 over a unix/named-pipe socket.

**Spec:** [`docs/superpowers/specs/2026-07-31-nimbus-glossary-llm-wiring-design.md`](../specs/2026-07-31-nimbus-glossary-llm-wiring-design.md). Read §2–§4 before Task 1. Base slice: [`2026-07-30-nimbus-glossary-design.md`](../specs/2026-07-30-nimbus-glossary-design.md).

## Global Constraints

- **Branch:** `dev/asafgolombek/glossary-llm-wiring`, worktree `C:/gitrep/Nimbus/.claude/worktrees/glossary-llm-wiring`. Never commit on `main`. Use the WORKTREE absolute path for every Read/Edit — a main-repo path silently edits the wrong tree.
- **No `any`.** Use `unknown` for external data. TypeScript strict is non-negotiable.
- **I14/D12:** every SQLite write goes through `dbRun` / `dbExec` / `dbStmtRun` from `db/write.ts`. `SELECT`s use `db.query(...)` directly. `bun run audit:invariants` enforces this statically.
- **I11:** any indexed content reaching a model must pass through `wrapToolOutput`. Already satisfied inside `consolidateTerm`; do not add a second prompt path.
- **I7:** `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` stays at **102**. Do not add the new methods. There is a TypeScript mirror of that count at `packages/gateway/src/security-invariants.test.ts:566` — if you ever change one, change both.
- **Lint:** `bun run lint` reports "Checked 0 files" inside `.claude/worktrees` and **false-passes**. Always use `bunx biome check packages scripts`.
- **Markdown lint:** the `.markdownlint-cli2.jsonc` globs exclude `.claude/worktrees/**`, so `bun run lint:markdown` silently skips docs in this worktree. Lint by explicit path: `bunx markdownlint-cli2 <file>`.
- **Exit codes:** verify every gate with `cmd > /tmp/x.log 2>&1; echo "EXIT=$?"`. A pipe returns the last command's status; this repo has reported a passing gate that had failed.
- **`tsc --noEmit -p packages/gateway/tsconfig.json` does NOT typecheck `test/`** (`include` is `src/**/*`). It is never evidence about a file under `packages/gateway/test/`.
- **`audit:any` without `--check` always exits 0** (false pass). Derive gate commands from `PREFLIGHT_GATES` in `scripts/lib/preflight-gates.ts`.
- **Red-prove every new test:** break the code, confirm the test fails *for the right reason*, restore, confirm green. A mutation that breaks everything proves nothing.
- **Coverage:** new source files carry a ≥80% line **and** branch floor. Local `bunfig.toml` sets `coverage = false`, so local numbers are not evidence — use `bash scripts/coverage-floor/reseed-docker.sh` (~8 min; a run reporting ~199 source files is broken, ~985 is real). Fix coverage with tests, never exclusions.
- **Avoid unreachable branches.** `noUncheckedIndexedAccess` forces `??` fallbacks that can never execute and permanently dent branch coverage. Prefer `const v = map.get(k); if (v === undefined) …` over `map.has(k)` + `map.get(k) ?? ""`.
- **DI over `mock.module`** in CLI tests — `mock.module` leaks process-globally in the combined `bun test packages/cli/src` run on CI-Linux and never reproduces on Windows.
- Commit after every task. Commit messages are discarded on squash-merge, but write real ones anyway.

## File Structure

**Create:**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/glossary/glossary-llm-adapter.ts` | `createGlossaryLlm(router)` — the local-only `ConsolidatorLlm` |
| `packages/gateway/src/glossary/glossary-llm-adapter.test.ts` | Adapter unit tests, incl. the remote-rejection guarantee |
| `packages/gateway/src/ipc/glossary-rpc.ts` | `glossary.refresh` / `glossary.rebuild` long-running handlers |
| `packages/gateway/src/ipc/glossary-rpc.test.ts` | RPC unit tests |

**Modify:**

| File | Change |
| --- | --- |
| `packages/gateway/src/llm/router.ts` | Export `isLocalProviderKind` |
| `packages/gateway/src/config/nimbus-toml.ts` | `[glossary].use_llm` |
| `packages/gateway/src/glossary/glossary-types.ts` | `GlossaryPassProgress` |
| `packages/gateway/src/glossary/glossary-store.ts` | `selectSnippetUpgradeBatch`; `markConsolidated` stamps `last_attempt_at` |
| `packages/gateway/src/glossary/glossary-extract.ts` | Upgrade batch, `UPGRADE_RESERVE`, new summary fields, `onProgress` |
| `packages/gateway/src/glossary/glossary-refresh.ts` | `runNow`, `status`, `GlossaryRefresherError`, `runPass` shape |
| `packages/gateway/src/agents/glossary.ts` | Snippet-fallback gap note; `--refresh` remediation |
| `packages/gateway/src/ipc/lan-rpc.ts` | `"glossary"` → `FORBIDDEN_OVER_LAN` |
| `packages/gateway/src/ipc/server/options.ts` | `glossaryRefresher?` |
| `packages/gateway/src/ipc/server/dispatchers.ts` | `tryDispatchGlossaryRpc` + chain entry |
| `packages/gateway/src/platform/assemble.ts` | `glossaryLlm` opt; adapter construction; `ipcOpts.glossaryRefresher` |
| `packages/cli/src/commands/_agent-brief-cli.ts` | `beforeCall` hook |
| `packages/cli/src/commands/glossary.ts` | Real `--refresh` / `--rebuild` / `--yes` |

---

## Task 1: Local-only LLM adapter

**Files:**

- Modify: `packages/gateway/src/llm/router.ts` (export helper near `LOCAL_PROVIDER_IDS`, line ~31)
- Create: `packages/gateway/src/glossary/glossary-llm-adapter.ts`
- Test: `packages/gateway/src/glossary/glossary-llm-adapter.test.ts`
- Test: `packages/gateway/src/llm/router.test.ts` (append)

**Interfaces:**

- Consumes: `LlmRouter.selectProvider(task, { preferLocal })` from `llm/router.ts`; `ConsolidatorLlm` from `glossary/glossary-consolidate.ts` (`{ generateJson: (prompt: string, signal?: AbortSignal) => Promise<string | null> }`).
- Produces: `createGlossaryLlm(router: LlmRouter): ConsolidatorLlm` and `isLocalProviderKind(id: LlmProviderKind): boolean`. Task 3 consumes `createGlossaryLlm`.

**Why the guard exists:** `selectProvider(_, { preferLocal: true })` walks `["ollama","llamacpp","remote"]` and returns the first *available* one — so with both local providers down it returns remote. `[glossary]` is default-on and spec §7 promises "local-only, no egress". Reject on `providerId` **before** `generate()`; reading `result.isLocal` afterwards reports egress that already happened.

**Do NOT call `router.generate()`.** It re-selects and its `fitPromptOrFallback` can route to a remote provider on context overflow. Call `provider.generate()` directly — the same thing `createBriefLlm` does.

- [ ] **Step 1: Export the local-kind helper**

In `packages/gateway/src/llm/router.ts`, immediately after the existing `const LOCAL_PROVIDER_IDS: ReadonlySet<LlmProviderKind> = new Set(["ollama", "llamacpp"]);`:

```ts
/**
 * Whether a provider kind runs on this machine.
 *
 * Exported so a caller can enforce local-only routing BEFORE dispatching a
 * prompt. `selectProvider(_, { preferLocal: true })` only expresses a
 * preference — it falls through to `remote` when no local provider answers —
 * so a surface that promises no egress must check the kind itself. The set
 * stays module-private; only the predicate is exported.
 */
export function isLocalProviderKind(id: LlmProviderKind): boolean {
  return LOCAL_PROVIDER_IDS.has(id);
}
```

- [ ] **Step 2: Write the failing adapter tests**

Create `packages/gateway/src/glossary/glossary-llm-adapter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import { LlmRouter } from "../llm/router.ts";
import type { LlmProvider, LlmProviderKind } from "../llm/types.ts";
import { createGlossaryLlm } from "./glossary-llm-adapter.ts";

function fakeProvider(
  id: LlmProviderKind,
  opts: { available: boolean; text?: string },
): LlmProvider {
  return {
    providerId: id,
    isAvailable: () => Promise.resolve(opts.available),
    listModels: () => Promise.resolve([]),
    generate: () =>
      Promise.resolve({
        text: opts.text ?? "{}",
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: `fake-${id}`,
        isLocal: id !== "remote",
        provider: id,
      }),
  };
}

function routerWith(...providers: LlmProvider[]): LlmRouter {
  const r = new LlmRouter({
    preferLocal: true,
    remoteModel: "remote-model",
    localModel: "local-model",
    minReasoningParams: 0,
    enforceAirGap: false,
  });
  for (const p of providers) r.registerProvider(p);
  return r;
}

describe("createGlossaryLlm", () => {
  it("returns the raw text from an available local provider", async () => {
    const llm = createGlossaryLlm(
      routerWith(fakeProvider("ollama", { available: true, text: '{"isDomainTerm":true}' })),
    );
    expect(await llm.generateJson("prompt")).toBe('{"isDomainTerm":true}');
  });

  it("falls back to llamacpp when ollama is down", async () => {
    const llm = createGlossaryLlm(
      routerWith(
        fakeProvider("ollama", { available: false }),
        fakeProvider("llamacpp", { available: true, text: "from-llamacpp" }),
      ),
    );
    expect(await llm.generateJson("prompt")).toBe("from-llamacpp");
  });

  // THE load-bearing test: this is the whole "local-only, no egress" guarantee.
  it("returns null rather than using an available REMOTE provider", async () => {
    let remoteCalled = false;
    const remote = fakeProvider("remote", { available: true, text: "LEAKED" });
    const spied: LlmProvider = {
      ...remote,
      generate: (o) => {
        remoteCalled = true;
        return remote.generate(o);
      },
    };
    const llm = createGlossaryLlm(routerWith(fakeProvider("ollama", { available: false }), spied));
    expect(await llm.generateJson("prompt")).toBeNull();
    expect(remoteCalled).toBe(false);
  });

  it("returns null when no provider is available at all", async () => {
    const llm = createGlossaryLlm(routerWith(fakeProvider("ollama", { available: false })));
    expect(await llm.generateJson("prompt")).toBeNull();
  });

  it("returns null without calling a provider when the signal is already aborted", async () => {
    let called = false;
    const local = fakeProvider("ollama", { available: true, text: "x" });
    const llm = createGlossaryLlm(
      routerWith({
        ...local,
        generate: (o) => {
          called = true;
          return local.generate(o);
        },
      }),
    );
    const ac = new AbortController();
    ac.abort();
    expect(await llm.generateJson("prompt", ac.signal)).toBeNull();
    expect(called).toBe(false);
  });
});
```

Append to `packages/gateway/src/llm/router.test.ts`:

```ts
describe("isLocalProviderKind", () => {
  it("classifies ollama and llamacpp as local, remote as not", () => {
    expect(isLocalProviderKind("ollama")).toBe(true);
    expect(isLocalProviderKind("llamacpp")).toBe(true);
    expect(isLocalProviderKind("remote")).toBe(false);
  });
});
```

Add `isLocalProviderKind` to that file's existing import from `./router.ts`.

- [ ] **Step 3: Run the tests to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-llm-adapter.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t1.log
```

Expected: FAIL — cannot resolve `./glossary-llm-adapter.ts`.

- [ ] **Step 4: Write the adapter**

Create `packages/gateway/src/glossary/glossary-llm-adapter.ts`:

```ts
import { isLocalProviderKind, type LlmRouter } from "../llm/router.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";

/**
 * Production `ConsolidatorLlm` over the existing router — LOCAL PROVIDERS ONLY.
 *
 * Unlike `briefs/brief-llm-adapter.ts` there is no `preferLocal` parameter and
 * no remote arm. `[briefs]` is default-off and documents source-text egress as
 * its most privacy-sensitive act; `[glossary]` is default-ON and spec §7
 * justifies that with "local-only, no egress". `selectProvider` only expresses
 * a PREFERENCE — it returns the remote provider when no local one answers — so
 * the kind is checked here, before any prompt is dispatched. Checking
 * `LlmGenerateResult.isLocal` instead would report egress that already
 * happened.
 *
 * Task is "summarisation", not "reasoning": `meetsCapabilityFloor` applies
 * `minReasoningParams` only to reasoning/agent_step, and consolidation (read a
 * few snippets, emit small JSON) does not need a large model. Gating it behind
 * the reasoning floor would exclude exactly the small local models that make a
 * local-only guarantee viable on a laptop.
 *
 * `provider.generate` is called directly rather than `router.generate`, whose
 * `fitPromptOrFallback` can route an oversized prompt to a remote provider.
 * The glossary prompt is bounded (<=5 sources x ~512 chars) so no truncation
 * path is needed.
 */
export function createGlossaryLlm(router: LlmRouter): ConsolidatorLlm {
  return {
    async generateJson(prompt: string, signal?: AbortSignal): Promise<string | null> {
      if (signal?.aborted === true) return null;
      const provider = await router.selectProvider("summarisation", { preferLocal: true });
      if (provider === undefined) return null;
      if (!isLocalProviderKind(provider.providerId)) return null;
      const result = await provider.generate({
        task: "summarisation",
        prompt,
        temperature: 0,
      });
      return result.text;
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
bun test packages/gateway/src/glossary/glossary-llm-adapter.test.ts packages/gateway/src/llm/router.test.ts > /tmp/t1.log 2>&1; echo "EXIT=$?"; tail -10 /tmp/t1.log
```

Expected: PASS, 5 adapter tests + the router suite.

- [ ] **Step 6: Red-prove the remote-rejection test**

Delete the `if (!isLocalProviderKind(provider.providerId)) return null;` line, re-run.
Expected: the "returns null rather than using an available REMOTE provider" test FAILS with `remoteCalled` true and the result `"LEAKED"`. Restore the line, re-run, expect green.

- [ ] **Step 7: Gates and commit**

```bash
bunx biome check packages scripts > /tmp/b.log 2>&1; echo "BIOME=$?"
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"
git add packages/gateway/src/llm/router.ts packages/gateway/src/llm/router.test.ts packages/gateway/src/glossary/glossary-llm-adapter.ts packages/gateway/src/glossary/glossary-llm-adapter.test.ts
git commit -m "feat(glossary): local-only ConsolidatorLlm adapter over LlmRouter"
```

---

## Task 2: `[glossary].use_llm` config

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts:1488-1560` (`NimbusGlossaryToml`, `DEFAULT_NIMBUS_GLOSSARY_TOML`, `applyNimbusGlossaryKey`)
- Test: `packages/gateway/src/config/nimbus-toml-glossary.test.ts` (append to the existing `[glossary]` describe)

**Interfaces:**

- Produces: `NimbusGlossaryToml.useLlm: boolean` (default `true`). Task 3 reads it.

**Trap:** `applyNimbusGlossaryKey` handles `enabled` as a bool and then falls through to `parseIntDec` for *everything else*, bailing on `n === undefined`. A `use_llm = true` line hits `parseIntDec("true") === undefined` and is silently dropped. The new key needs its own branch **before** the int parse.

- [ ] **Step 1: Write the failing test**

Append inside the existing `[glossary]` describe block in `packages/gateway/src/config/nimbus-toml-glossary.test.ts`:

```ts
it("defaults use_llm to true", () => {
  expect(parseNimbusGlossaryToml("").useLlm).toBe(true);
});

it("parses use_llm = false", () => {
  expect(parseNimbusGlossaryToml("[glossary]\nuse_llm = false\n").useLlm).toBe(false);
});

// Regression: use_llm must be parsed as a BOOL. The int branch below it turns
// `true` into undefined and drops the key silently.
it("parses use_llm independently of enabled", () => {
  const cfg = parseNimbusGlossaryToml("[glossary]\nenabled = true\nuse_llm = false\n");
  expect(cfg.enabled).toBe(true);
  expect(cfg.useLlm).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test packages/gateway/src/config/nimbus-toml.test.ts -t "use_llm" > /tmp/t2.log 2>&1; echo "EXIT=$?"; tail -15 /tmp/t2.log
```

Expected: FAIL — `useLlm` does not exist on the type.

- [ ] **Step 3: Add the field, default, and parse branch**

In `NimbusGlossaryToml`, after `enabled`:

```ts
  /**
   * Consolidate via a LOCAL model. Default on, but separable from `enabled`:
   * turning this off keeps the cheap snippet glossary while sparing a laptop
   * up to `max_new_terms_per_pass` sequential local-model calls per sync burst.
   */
  useLlm: boolean;
```

In `DEFAULT_NIMBUS_GLOSSARY_TOML`, after `enabled: true,`: `useLlm: true,`

In `applyNimbusGlossaryKey`, directly after the `enabled` branch and BEFORE `const n = parseIntDec(valRaw);`:

```ts
  if (key === "use_llm") {
    const b = parseBool(valRaw);
    if (b !== undefined) out.useLlm = b;
    return;
  }
```

- [ ] **Step 4: Run to verify it passes**

```bash
bun test packages/gateway/src/config/nimbus-toml.test.ts > /tmp/t2.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t2.log
```

- [ ] **Step 5: Red-prove**

Move the `use_llm` branch to *after* the `parseIntDec` bail (`if (n === undefined || n <= 0) return;`). Re-run: "parses use_llm = false" FAILS (stays `true`). Restore, re-run green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/config/nimbus-toml.ts packages/gateway/src/config/nimbus-toml.test.ts
git commit -m "feat(glossary): add [glossary].use_llm config key"
```

---

## Task 3: Inject the adapter into the scheduled pass

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts:398-456` (`SchedulerWithMeshOpts`, `createSchedulerWithMesh`), `:1758-1767` (call site)
- Test: `packages/gateway/src/platform/assemble.test.ts` — see Step 1 note

**Interfaces:**

- Consumes: `createGlossaryLlm` (Task 1), `NimbusGlossaryToml.useLlm` (Task 2), existing `ConsolidatorLlm`.
- Produces: `SchedulerWithMeshOpts.glossaryLlm?: ConsolidatorLlm`.

**On the Task 12 ruling from the base slice:** that ruling declined to widen `SchedulerWithMeshOpts` — but it was about getting the refresher *out* for shutdown registration, where the alternative was a `sidecarStops` out-parameter. This is an *input* dependency, and the interface already carries eight. Ordering is not a constraint: `buildLlmRegistryFromToml` is at `:1645`, `createSchedulerWithMesh` at `:1758`.

- [ ] **Step 1: Add the option and thread it**

`createSchedulerWithMesh` is not directly unit-tested (it needs a full platform); its behaviour is covered by the existing `packages/gateway/src/platform/` suite plus the e2e. This task is wiring — the proof is `tsc` plus the Task 5 integration tests that exercise `runGlossaryPass` with an `llm`. Do not invent a test that only asserts a property is passed through.

In `interface SchedulerWithMeshOpts`, after `isConnectorAllowed`:

```ts
  /**
   * Local-only consolidation model for the glossary pass. Optional so tests and
   * degraded boots keep the snippet path. Gated below on `[glossary].use_llm`.
   */
  glossaryLlm?: ConsolidatorLlm;
```

Add the import at the top of `assemble.ts`:

```ts
import type { ConsolidatorLlm } from "../glossary/glossary-consolidate.ts";
import { createGlossaryLlm } from "../glossary/glossary-llm-adapter.ts";
```

Add `glossaryLlm` to the destructure at `:414-423`.

Inside `createSchedulerWithMesh`, immediately after `const glossaryCfg = loadNimbusGlossaryFromConfigDir(paths.configDir);`:

```ts
  // Gate at the point of use, so the single config read stays single.
  const consolidationLlm = glossaryCfg.useLlm ? glossaryLlm : undefined;
```

In the `runPass` body, add to the `runGlossaryPass` options object:

```ts
        ...(consolidationLlm === undefined ? {} : { llm: consolidationLlm }),
```

- [ ] **Step 2: Pass the adapter at the call site**

At `assemble.ts:1758`, add to the `createSchedulerWithMesh({...})` argument object:

```ts
    glossaryLlm: createGlossaryLlm(llmRegistry.llmRouter),
```

- [ ] **Step 3: Typecheck and run the platform suite**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"; tail -5 /tmp/tsc.log
bun test packages/gateway/src/platform > /tmp/t3.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t3.log
```

- [ ] **Step 4: Verify the wiring by reading, not by trusting**

```bash
grep -n "glossaryLlm\|consolidationLlm\|createGlossaryLlm" packages/gateway/src/platform/assemble.ts
```

Expected: the interface field, the destructure, the `useLlm` gate, the spread into `runGlossaryPass`, and the call-site construction — five sites. IDE diagnostics in this repo produced 13 rounds of false "unused variable" reports during the base slice; trust `tsc` and `grep`, not the IDE.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(glossary): inject the local-only LLM into the scheduled pass"
```

---

## Task 4: Snippet-upgrade selection query

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-store.ts` (add `selectSnippetUpgradeBatch` after `selectPendingBatch` ~`:263`; amend `markConsolidated` ~`:312`)
- Test: `packages/gateway/src/glossary/glossary-store.test.ts`

**Interfaces:**

- Produces:

```ts
export function selectSnippetUpgradeBatch(
  db: Database,
  limit: number,
  opts: { nowMs: number; retryBaseCooldownMs: number },
): GlossaryTerm[];
```

Task 5 consumes it.

**Two traps:**

1. **`LIMIT -1` means NO LIMIT in SQLite.** Task 5 computes `limit` by subtraction, so a negative value must return `[]` rather than the entire table. Guard explicitly.
2. `markConsolidated` must now stamp `last_attempt_at`, which makes the existing schema comment ("last consolidation attempt, success or failure") true and lets `ORDER BY last_attempt_at ASC` rotate fairly.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/glossary/glossary-store.test.ts` (reuse the file's existing fresh-DB `beforeEach` and its row-insert helper; if the helper does not cover `definition_source`, insert with an explicit `dbRun` in the test):

```ts
describe("selectSnippetUpgradeBatch", () => {
  const OPTS = { nowMs: 1_000_000, retryBaseCooldownMs: 60_000 };

  function seedConsolidated(
    key: string,
    p: { source: "llm" | "snippet"; score: number; attempts?: number; lastAttemptAt?: number },
  ): void {
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, definition, definition_source, doc_freq,
          service_spread, score, form, first_seen_at, last_seen_at, attempts,
          last_attempt_at, updated_at)
       VALUES (?, ?, 'consolidated', 'def', ?, 5, 2, ?, 'acronym', 1, 2, ?, ?, 1)`,
      [key, key.toUpperCase(), p.source, p.score, p.attempts ?? 0, p.lastAttemptAt ?? 0],
    );
  }

  it("selects only consolidated snippet-sourced rows", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10 });
    seedConsolidated("slo", { source: "llm", score: 99 });
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, doc_freq, service_spread, score, form,
          first_seen_at, last_seen_at, updated_at)
       VALUES ('pend', 'PEND', 'pending', 5, 2, 50, 'acronym', 1, 2, 1)`,
      [],
    );
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual(["cdr"]);
  });

  // Ordering, not count: a count-only assertion passes under either ordering.
  it("rotates round-robin by last_attempt_at ascending", () => {
    seedConsolidated("recent", { source: "snippet", score: 99, lastAttemptAt: 900_000 });
    seedConsolidated("never", { source: "snippet", score: 1, lastAttemptAt: 0 });
    seedConsolidated("middle", { source: "snippet", score: 50, lastAttemptAt: 400_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual([
      "never",
      "middle",
      "recent",
    ]);
  });

  it("withholds a term still inside its exponential backoff", () => {
    // attempts=1 -> cooldown 60_000; last attempt at 999_000 -> due at 1_059_000 > now.
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 999_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS)).toEqual([]);
  });

  it("admits a term whose backoff has elapsed", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10, attempts: 1, lastAttemptAt: 100_000 });
    expect(selectSnippetUpgradeBatch(db, 10, OPTS).map((t) => t.termKey)).toEqual(["cdr"]);
  });

  // SQLite treats LIMIT -1 as unlimited; Task 5 derives the limit by subtraction.
  it("returns nothing for a zero or negative limit", () => {
    seedConsolidated("cdr", { source: "snippet", score: 10 });
    expect(selectSnippetUpgradeBatch(db, 0, OPTS)).toEqual([]);
    expect(selectSnippetUpgradeBatch(db, -1, OPTS)).toEqual([]);
  });
});

it("markConsolidated stamps last_attempt_at", () => {
  dbRun(
    db,
    `INSERT INTO glossary_term
       (term_key, display_term, status, doc_freq, service_spread, score, form,
        first_seen_at, last_seen_at, updated_at)
     VALUES ('cdr', 'CDR', 'pending', 5, 2, 10, 'acronym', 1, 2, 1)`,
    [],
  );
  markConsolidated(db, {
    termKey: "cdr",
    definition: "d",
    definitionSource: "llm",
    synonyms: [],
    nearMisses: [],
    nowMs: 777,
  });
  const row = db
    .query("SELECT last_attempt_at FROM glossary_term WHERE term_key = 'cdr'")
    .get() as { last_attempt_at: number };
  expect(row.last_attempt_at).toBe(777);
});
```

Add `selectSnippetUpgradeBatch` to the file's import from `./glossary-store.ts`, and `dbRun` from `../db/write.ts` if not already imported.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-store.test.ts > /tmp/t4.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t4.log
```

Expected: FAIL — `selectSnippetUpgradeBatch` is not exported.

- [ ] **Step 3: Implement**

In `glossary-store.ts`, after `selectPendingBatch`:

```ts
/**
 * Consolidated terms whose definition is a verbatim snippet, due for an
 * LLM re-consolidation.
 *
 * Selected only when an LLM is available — with none, an "upgrade" would
 * re-derive the same snippet from the same sources.
 *
 * `ORDER BY last_attempt_at ASC` rotates round-robin so a large snippet
 * population drains fairly, and the backoff clause — the same shape
 * `selectPendingBatch` uses, so `retryCooldownMs` stays the single definition
 * of the curve — keeps a repeatedly-failing term to one attempt per 24 h
 * instead of letting it hold a reserved slot every pass.
 *
 * The `limit <= 0` guard is load-bearing, not defensive noise: the caller
 * derives the limit by subtraction, and SQLite treats `LIMIT -1` as UNLIMITED,
 * so a negative value would consolidate the entire snippet population in one
 * pass.
 */
export function selectSnippetUpgradeBatch(
  db: Database,
  limit: number,
  opts: { nowMs: number; retryBaseCooldownMs: number },
): GlossaryTerm[] {
  if (limit <= 0) return [];
  const rows = db
    .query(
      `SELECT * FROM glossary_term
       WHERE status = 'consolidated' AND definition_source = 'snippet'
         AND (
           attempts = 0
           OR last_attempt_at + MIN(86400000, ? * (1 << (attempts - 1))) <= ?
         )
       ORDER BY last_attempt_at ASC, score DESC
       LIMIT ?`,
    )
    .all(opts.retryBaseCooldownMs, opts.nowMs, limit) as Row[];
  return rows.map(toTerm);
}
```

In `markConsolidated`, add `last_attempt_at = ?` to the SET list and `p.nowMs` to the params array in the matching position:

```ts
    `UPDATE glossary_term
     SET status = 'consolidated', definition = ?, definition_source = ?,
         synonyms = ?, near_misses = ?, consolidated_at = ?,
         stats_verified_at = ?, last_attempt_at = ?, updated_at = ?
     WHERE term_key = ?`,
    [
      p.definition,
      p.definitionSource,
      JSON.stringify(p.synonyms),
      JSON.stringify(p.nearMisses),
      p.nowMs,
      p.nowMs,
      p.nowMs,
      p.nowMs,
      p.termKey,
    ],
```

Count the placeholders against the params: 8 `?` in SET/WHERE order, 9 params including `termKey`. A miscount here desyncs every binding — the base slice recorded exactly that failure mode.

- [ ] **Step 4: Run to verify they pass**

```bash
bun test packages/gateway/src/glossary/glossary-store.test.ts > /tmp/t4.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t4.log
```

- [ ] **Step 5: Red-prove the ordering and the limit guard**

Change `ORDER BY last_attempt_at ASC, score DESC` to `ORDER BY score DESC`. Re-run: the round-robin test FAILS with `["recent","middle","never"]`. Restore.
Delete `if (limit <= 0) return [];`. Re-run: the negative-limit test FAILS (returns `["cdr"]` because `LIMIT -1` is unlimited). Restore. Re-run green.

- [ ] **Step 6: Invariants and commit**

```bash
bun run audit:invariants > /tmp/inv.log 2>&1; echo "INV=$?"
git add packages/gateway/src/glossary/glossary-store.ts packages/gateway/src/glossary/glossary-store.test.ts
git commit -m "feat(glossary): select snippet-sourced terms for LLM upgrade"
```

---

## Task 5: Run upgrades in the pass, with a reserved slot floor

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-types.ts` (add `GlossaryPassProgress`)
- Modify: `packages/gateway/src/glossary/glossary-extract.ts` (`GlossaryPassOptions`, `GlossaryPassSummary`, `consolidatePhase`, `runGlossaryPass`, `rebuildGlossary`)
- Test: `packages/gateway/src/glossary/glossary-extract.test.ts`

**Interfaces:**

- Consumes: `selectSnippetUpgradeBatch` (Task 4).
- Produces: `GlossaryPassSummary` with `upgraded`, `upgradesVetoed`, `vetoedTerms`, `llmConfigured`, `llmProduced`; `GlossaryPassOptions.onProgress?`; `GlossaryPassProgress`. Tasks 7, 8 and 10 consume these.

**The allocation rule (spec §3.2):** query upgrades FIRST with `LIMIT min(UPGRADE_RESERVE, maxNewTermsPerPass)`; give pending the remainder. With no upgrades outstanding, pending gets the whole budget. Execute pending first, then upgrades. This guarantees upgrades are never starved while still giving new terms 20 of 25 slots.

- [ ] **Step 1: Add the progress type**

In `glossary-types.ts`:

```ts
/** Per-term progress emitted during phase B, for on-demand passes. */
export type GlossaryPassProgress = {
  done: number;
  total: number;
  consolidated: number;
  upgraded: number;
  vetoed: number;
  retried: number;
};
```

- [ ] **Step 2: Write the failing tests**

Append to `packages/gateway/src/glossary/glossary-extract.test.ts`. Reuse the file's existing DB setup, its item-seeding helper and its fake-LLM helper; the fake below matches the existing `ConsolidatorLlm` shape.

```ts
describe("snippet upgrades", () => {
  function llmReturning(json: string, calls: string[] = []): ConsolidatorLlm {
    return {
      generateJson: (prompt: string) => {
        calls.push(prompt);
        return Promise.resolve(json);
      },
    };
  }

  function seedSnippetTerm(key: string, itemId: string, score: number): void {
    dbRun(
      db,
      `INSERT INTO glossary_term
         (term_key, display_term, status, definition, definition_source, doc_freq,
          service_spread, score, form, first_seen_at, last_seen_at, top_sources,
          attempts, last_attempt_at, updated_at)
       VALUES (?, ?, 'consolidated', 'old snippet text', 'snippet', 5, 2, ?, 'acronym',
               1, 2, ?, 0, 0, 1)`,
      [key, key.toUpperCase(), score, JSON.stringify([{ itemId, title: "t", url: null, service: "slack", modifiedAt: 2 }])],
    );
  }

  it("does not run upgrades when no LLM is configured", async () => {
    seedSnippetTerm("cdr", "slack:1", 10);
    const summary = await runGlossaryPass(db, { ...PASS_OPTS });
    expect(summary.upgraded).toBe(0);
    const row = db.query("SELECT definition_source FROM glossary_term WHERE term_key='cdr'").get() as { definition_source: string };
    expect(row.definition_source).toBe("snippet");
  });

  it("upgrades a snippet definition in place and re-sources it as llm", async () => {
    seedSnippetTerm("cdr", "slack:1", 10);
    const summary = await runGlossaryPass(db, {
      ...PASS_OPTS,
      llm: llmReturning('{"isDomainTerm":true,"definition":"model definition","alsoKnownAs":[]}'),
    });
    expect(summary.upgraded).toBe(1);
    const row = db
      .query("SELECT definition, definition_source FROM glossary_term WHERE term_key='cdr'")
      .get() as { definition: string; definition_source: string };
    expect(row.definition).toBe("model definition");
    expect(row.definition_source).toBe("llm");
  });

  it("leaves the snippet definition intact when the upgrade fails", async () => {
    seedSnippetTerm("cdr", "slack:1", 10);
    const summary = await runGlossaryPass(db, {
      ...PASS_OPTS,
      llm: { generateJson: () => Promise.resolve("not json") },
    });
    expect(summary.upgraded).toBe(0);
    const row = db
      .query("SELECT definition, definition_source, attempts FROM glossary_term WHERE term_key='cdr'")
      .get() as { definition: string; definition_source: string; attempts: number };
    expect(row.definition).toBe("old snippet text");
    expect(row.definition_source).toBe("snippet");
    expect(row.attempts).toBe(1);
  });

  it("vetoes an upgraded term, unprojects it, and names it in the summary", async () => {
    seedSnippetTerm("cdr", "slack:1", 10);
    const summary = await runGlossaryPass(db, {
      ...PASS_OPTS,
      llm: llmReturning('{"isDomainTerm":false,"definition":"","alsoKnownAs":[]}'),
    });
    expect(summary.upgradesVetoed).toBe(1);
    expect(summary.vetoedTerms).toEqual(["cdr"]);
    const status = db.query("SELECT status FROM glossary_term WHERE term_key='cdr'").get() as { status: string };
    expect(status.status).toBe("vetoed");
    const item = db
      .query("SELECT COUNT(*) AS n FROM item WHERE external_id = 'glossary:cdr'")
      .get() as { n: number };
    expect(item.n).toBe(0);
  });

  // The Q2.1 guarantee: a saturated pending queue must NOT starve upgrades.
  it("reserves upgrade slots even when the pending queue exceeds the budget", async () => {
    for (let i = 0; i < 30; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
    for (let i = 0; i < 8; i++) seedSnippetTerm(`snip${String(i)}`, "slack:1", 5);
    const summary = await runGlossaryPass(db, {
      ...PASS_OPTS,
      maxNewTermsPerPass: 25,
      llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
    });
    expect(summary.upgraded).toBe(5);
    expect(summary.consolidated).toBe(20);
  });

  it("gives pending the whole budget when no upgrades are outstanding", async () => {
    for (let i = 0; i < 30; i++) seedPendingTerm(`pending${String(i)}`, 100 - i);
    const summary = await runGlossaryPass(db, {
      ...PASS_OPTS,
      maxNewTermsPerPass: 25,
      llm: llmReturning('{"isDomainTerm":true,"definition":"d","alsoKnownAs":[]}'),
    });
    expect(summary.consolidated).toBe(25);
    expect(summary.upgraded).toBe(0);
  });

  it("reports llmConfigured and llmProduced separately", async () => {
    seedPendingTerm("cdr", 10);
    const none = await runGlossaryPass(db, { ...PASS_OPTS });
    expect(none.llmConfigured).toBe(false);
    expect(none.llmProduced).toBe(false);

    const dead = await runGlossaryPass(db, {
      ...PASS_OPTS,
      llm: { generateJson: () => Promise.resolve(null) },
    });
    expect(dead.llmConfigured).toBe(true);
    expect(dead.llmProduced).toBe(false);
  });
});
```

`seedPendingTerm(key, score)` is a helper you add alongside `seedSnippetTerm`: the same INSERT with `status='pending'`, no `definition`/`definition_source`, and a `top_sources` array of one real seeded item so `consolidateTerm`'s empty-snippets guard does not short-circuit. **The seeded item must exist in `item`** — otherwise `snippetsFor` returns `[]` and every term retries, which would make the reserve test pass for the wrong reason.

- [ ] **Step 3: Run to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-extract.test.ts > /tmp/t5.log 2>&1; echo "EXIT=$?"; tail -25 /tmp/t5.log
```

Expected: FAIL — `summary.upgraded` is `undefined`.

- [ ] **Step 4: Implement**

In `glossary-extract.ts`, add the import:

```ts
import type { GlossaryPassProgress, GlossaryTerm } from "./glossary-types.ts";
```

and add `selectSnippetUpgradeBatch` to the existing `./glossary-store.ts` import.

Add the constant beside `NEAR_MISS_POOL`:

```ts
/**
 * Upgrade slots held back from `maxNewTermsPerPass`.
 *
 * Without a floor, a pending queue that stays above the budget starves snippet
 * upgrades indefinitely — a term consolidated without a model would never
 * improve for as long as first-time mining continues. New terminology still
 * wins the other 20 of 25 slots; only the unbounded half of the starvation is
 * removed. A module constant rather than a config key, matching
 * `NEAR_MISS_POOL` / `MAX_SYNONYMS`.
 */
const UPGRADE_RESERVE = 5;

/** Cap on `vetoedTerms` — this is a user notification, not an audit trail. */
const VETOED_TERMS_REPORTED = 10;
```

Extend `GlossaryPassOptions`:

```ts
  /** Per-term progress, for on-demand passes driven by `nimbus glossary --refresh`. */
  onProgress?: (p: GlossaryPassProgress) => void;
```

Extend `GlossaryPassSummary`:

```ts
  /** Snippet definitions re-consolidated by the model this pass. */
  upgraded: number;
  /** Previously-consolidated snippet terms the model rejected — they LEFT the glossary. */
  upgradesVetoed: number;
  /** Which ones, capped at `VETOED_TERMS_REPORTED`, so the CLI can name them. */
  vetoedTerms: string[];
  /** An adapter was supplied (i.e. `[glossary].use_llm` is on and one was built). */
  llmConfigured: boolean;
  /** The model actually answered at least once — a definition or a veto. */
  llmProduced: boolean;
```

Replace `consolidatePhase` with:

```ts
async function consolidatePhase(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<{
  consolidated: number;
  upgraded: number;
  vetoed: number;
  upgradesVetoed: number;
  vetoedTerms: string[];
  retried: number;
  llmProduced: boolean;
  aborted: boolean;
}> {
  // Upgrades are queried FIRST so their reserved slots come off the top; the
  // pending batch takes what is left. With nothing to upgrade, `k` is 0 and new
  // terms get the entire budget.
  const upgradeBatch =
    opts.llm === undefined
      ? []
      : selectSnippetUpgradeBatch(db, Math.min(UPGRADE_RESERVE, opts.maxNewTermsPerPass), {
          nowMs: opts.nowMs,
          retryBaseCooldownMs: opts.retryBaseCooldownMs,
        });
  const batch = selectPendingBatch(db, opts.maxNewTermsPerPass - upgradeBatch.length, {
    nowMs: opts.nowMs,
    retryBaseCooldownMs: opts.retryBaseCooldownMs,
    minDocFreq: opts.minDocFreq,
  });
  const knownKeys = listConsolidated(db, NEAR_MISS_POOL).map((t) => t.termKey);

  const work: Array<{ term: GlossaryTerm; isUpgrade: boolean }> = [
    ...batch.map((term) => ({ term, isUpgrade: false })),
    ...upgradeBatch.map((term) => ({ term, isUpgrade: true })),
  ];

  let consolidated = 0;
  let upgraded = 0;
  let vetoed = 0;
  let upgradesVetoed = 0;
  let retried = 0;
  let llmProduced = false;
  const vetoedTerms: string[] = [];
  let done = 0;

  for (const { term, isUpgrade } of work) {
    if (opts.signal?.aborted === true) {
      return {
        consolidated, upgraded, vetoed, upgradesVetoed, vetoedTerms, retried,
        llmProduced, aborted: true,
      };
    }

    const snippets = snippetsFor(
      db,
      term.topSources.map((s) => s.itemId),
    );
    const outcome = await consolidateTerm(term, snippets, {
      ...(opts.llm === undefined ? {} : { llm: opts.llm }),
      timeoutMs: opts.consolidateTimeoutMs,
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });

    if (outcome.kind === "vetoed") {
      // Only a model can veto, so this proves the model answered.
      llmProduced = true;
      unprojectTerm(db, term.termKey);
      markVetoed(db, term.termKey, opts.nowMs);
      vetoed += 1;
      if (isUpgrade) {
        upgradesVetoed += 1;
        // A term the user could see yesterday and cannot see today. Named so
        // `--refresh` can report it rather than letting it vanish silently.
        if (vetoedTerms.length < VETOED_TERMS_REPORTED) vetoedTerms.push(term.termKey);
      }
    } else if (outcome.kind === "retry") {
      // Stamps the attempt for BOTH queues' backoff — a failing upgrade steps
      // aside from its reserved slot exactly like a failing pending term.
      recordAttempt(db, term.termKey, opts.nowMs);
      retried += 1;
    } else {
      if (outcome.source === "llm") llmProduced = true;
      db.transaction(() => {
        markConsolidated(db, {
          termKey: term.termKey,
          definition: outcome.definition,
          definitionSource: outcome.source,
          synonyms: outcome.synonyms,
          nearMisses: findNearMisses(term.termKey, knownKeys),
          nowMs: opts.nowMs,
        });
        const stored = getTerm(db, term.termKey);
        if (stored !== null) projectTerm(db, stored, opts.nowMs);
      })();
      if (isUpgrade) upgraded += 1;
      else consolidated += 1;
    }

    done += 1;
    opts.onProgress?.({
      done,
      total: work.length,
      consolidated,
      upgraded,
      vetoed,
      retried,
    });
  }

  return {
    consolidated, upgraded, vetoed, upgradesVetoed, vetoedTerms, retried,
    llmProduced, aborted: opts.signal?.aborted === true,
  };
}
```

Update `runGlossaryPass`'s early-abort return so the summary shape stays total:

```ts
export async function runGlossaryPass(
  db: Database,
  opts: GlossaryPassOptions,
): Promise<GlossaryPassSummary> {
  const llmConfigured = opts.llm !== undefined;
  const a = discoverPhase(db, opts);
  if (opts.signal?.aborted === true) {
    return {
      ...a,
      consolidated: 0, upgraded: 0, vetoed: 0, upgradesVetoed: 0, vetoedTerms: [],
      retried: 0, llmConfigured, llmProduced: false, aborted: true,
    };
  }
  const b = await consolidatePhase(db, opts);
  return { ...a, ...b, llmConfigured };
}
```

- [ ] **Step 5: Run to verify they pass**

```bash
bun test packages/gateway/src/glossary > /tmp/t5.log 2>&1; echo "EXIT=$?"; tail -8 /tmp/t5.log
```

The pre-existing `glossary-resume.test.ts` and `glossary-reconcile.test.ts` must stay green.

- [ ] **Step 6: Red-prove the reserve**

Change the upgrade limit to `Math.min(UPGRADE_RESERVE, opts.maxNewTermsPerPass - batch.length)` computed AFTER the pending batch (i.e. revert to the leftover allocation), re-run. Expected: "reserves upgrade slots even when the pending queue exceeds the budget" FAILS with `upgraded === 0`, `consolidated === 25`. Restore, re-run green.

Then red-prove the veto reporting: delete the `if (vetoedTerms.length < …) vetoedTerms.push(…)` line. Expected: the veto test FAILS on `vetoedTerms`. Restore.

- [ ] **Step 7: Gates and commit**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"
bun run audit:invariants > /tmp/inv.log 2>&1; echo "INV=$?"
bunx biome check packages scripts > /tmp/b.log 2>&1; echo "BIOME=$?"
git add packages/gateway/src/glossary/
git commit -m "feat(glossary): upgrade snippet definitions with a reserved slot floor"
```

---

## Task 6: Surface the snippet fallback in the brief

**Files:**

- Modify: `packages/gateway/src/agents/glossary.ts` (`buildGaps` ~`:88-134`)
- Test: `packages/gateway/src/agents/glossary.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks — this reads the table directly.
- Produces: nothing consumed later.

**Constraint:** `GapCategory` is a **closed union in the published `@nimbus-dev/sdk`** — `"missing_entity_type" | "missing_relation_emit" | "missing_connector" | "missing_user_identity" | "empty_index"`. A new value needs an SDK release, so reuse `"missing_connector"`, as the three existing glossary notes already do.

Report the exact ratio rather than tripping at a "predominantly" threshold — there is no defensible cutoff, and the numbers are informative at any ratio.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/agents/glossary.test.ts` (reuse its existing DB + seeding helpers):

```ts
it("reports how many definitions are raw snippets", async () => {
  seedConsolidatedTerm("cdr", { definitionSource: "snippet" });
  seedConsolidatedTerm("slo", { definitionSource: "llm" });
  const brief = await runGlossary({}, { db, sessionId: "s" });
  const note = brief.gaps.find((g) => g.detail.includes("verbatim snippet"));
  expect(note).toBeDefined();
  expect(note?.detail).toContain("1 of 2");
  expect(note?.remediation).toContain("--refresh");
});

it("omits the snippet note when every definition came from a model", async () => {
  seedConsolidatedTerm("slo", { definitionSource: "llm" });
  const brief = await runGlossary({}, { db, sessionId: "s" });
  expect(brief.gaps.some((g) => g.detail.includes("verbatim snippet"))).toBe(false);
});
```

If `seedConsolidatedTerm` does not already take `definitionSource`, extend it; do not duplicate the helper.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/gateway/src/agents/glossary.test.ts > /tmp/t6.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t6.log
```

- [ ] **Step 3: Implement**

In `buildGaps`, after the `counts.pending > 0` block and before `return gaps;`:

```ts
  // Snippet-sourced definitions are verbatim quotes, not consolidations. They
  // are labelled per-entry by the renderer, but a user whose local model is
  // simply not running has no way to notice the pattern — the glossary looks
  // built, just oddly worded. Report the ratio rather than picking a
  // "predominantly" threshold nobody can justify.
  const snippetCount = (
    db
      .query(
        `SELECT COUNT(*) AS n FROM glossary_term
         WHERE status = 'consolidated' AND definition_source = 'snippet'`,
      )
      .get() as { n: number } | null
  )?.n ?? 0;
  if (snippetCount > 0) {
    gaps.push({
      category: "missing_connector",
      detail:
        `${String(snippetCount)} of ${String(counts.total)} definition(s) are verbatim snippets ` +
        "rather than model-consolidated.",
      remediation:
        "Start a local model (Ollama or llama.cpp) and run `nimbus glossary --refresh`; " +
        "snippet definitions are re-consolidated automatically on later passes.",
    });
  }
```

Also fix the now-false comment and remediation in the `lastPassAt === null` branch above it:

```ts
      detail: "The glossary extraction pass has not run yet.",
      remediation: "Run `nimbus glossary --refresh`, or wait for the next connector sync.",
```

and delete the three-line "Deliberately does NOT name `--refresh`" comment — the flag is wired in Task 10.

- [ ] **Step 4: Run to verify they pass**

```bash
bun test packages/gateway/src/agents/glossary.test.ts > /tmp/t6.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t6.log
```

- [ ] **Step 5: Red-prove**

Change `if (snippetCount > 0)` to `if (false)`. Re-run: the first test FAILS (`note` undefined). Restore. Change the query's `definition_source = 'snippet'` to `= 'llm'`. Re-run: the ratio assertion FAILS. Restore, re-run green.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/agents/glossary.ts packages/gateway/src/agents/glossary.test.ts
git commit -m "feat(glossary): report snippet-sourced definitions as a brief gap note"
```

---

## Task 7: On-demand passes through the refresher

**Files:**

- Modify: `packages/gateway/src/glossary/glossary-refresh.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (`runPass` signature at `:441`)
- Test: `packages/gateway/src/glossary/glossary-refresh.test.ts`

**Interfaces:**

- Consumes: `GlossaryPassSummary`, `GlossaryPassProgress` (Task 5); `rebuildGlossary` / `runGlossaryPass` (existing).
- Produces:

```ts
export class GlossaryRefresherError extends Error { readonly rpcCode: number }
export type GlossaryRunOptions = { rebuild: boolean; onProgress?: (p: GlossaryPassProgress) => void };
export type GlossaryRefresherDeps = {
  enabled: boolean;
  debounceMs: number;
  runPass: (signal: AbortSignal, opts: GlossaryRunOptions) => Promise<GlossaryPassSummary>;
  onError?: (err: unknown) => void;
};
export type GlossaryRefresher = {
  trigger: () => void;
  runNow: (opts: GlossaryRunOptions) => Promise<GlossaryPassSummary>;
  status: () => "idle" | "running" | "stopped" | "disabled";
  stop: () => void;
};
```

Task 8 consumes `runNow` and `status`.

**Why `status()` exists separately:** the RPC handler must reject a concurrent request as an immediate RPC error, not as a `passError` notification arriving after a successful `{ jobId }`. It checks `status()` synchronously before starting the job. `runNow` keeps its own guards as defence; there is no await between the check and `runNow`'s synchronous prologue, so they cannot interleave.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/glossary/glossary-refresh.test.ts`:

```ts
const SUMMARY: GlossaryPassSummary = {
  scanned: 0, discovered: 0, demoted: 0, consolidated: 0, upgraded: 0, vetoed: 0,
  upgradesVetoed: 0, vetoedTerms: [], retried: 0, llmConfigured: false,
  llmProduced: false, aborted: false,
};

describe("runNow", () => {
  it("runs immediately without waiting for the debounce", async () => {
    let ran = 0;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 60_000,
      runPass: () => { ran += 1; return Promise.resolve(SUMMARY); },
    });
    await r.runNow({ rebuild: false });
    expect(ran).toBe(1);
    r.stop();
  });

  it("forwards the rebuild flag", async () => {
    let sawRebuild: boolean | undefined;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: (_s, o) => { sawRebuild = o.rebuild; return Promise.resolve(SUMMARY); },
    });
    await r.runNow({ rebuild: true });
    expect(sawRebuild).toBe(true);
    r.stop();
  });

  it("rejects a concurrent call instead of awaiting the running pass", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => { release = res; });
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: async () => { await gate; return SUMMARY; },
    });
    const first = r.runNow({ rebuild: false });
    expect(r.status()).toBe("running");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_PASS_RUNNING");
    release?.();
    await first;
    expect(r.status()).toBe("idle");
    r.stop();
  });

  it("rejects when the glossary is disabled", async () => {
    const r = createGlossaryRefresher({
      enabled: false,
      debounceMs: 1,
      runPass: () => Promise.resolve(SUMMARY),
    });
    expect(r.status()).toBe("disabled");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_DISABLED");
  });

  it("rejects after stop()", async () => {
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: () => Promise.resolve(SUMMARY),
    });
    r.stop();
    expect(r.status()).toBe("stopped");
    await expect(r.runNow({ rebuild: false })).rejects.toThrow("ERR_GLOSSARY_STOPPED");
  });

  it("passes the refresher's abort signal so stop() cancels an on-demand pass", async () => {
    let seen: AbortSignal | undefined;
    const r = createGlossaryRefresher({
      enabled: true,
      debounceMs: 1,
      runPass: (s) => { seen = s; return Promise.resolve(SUMMARY); },
    });
    await r.runNow({ rebuild: false });
    expect(seen?.aborted).toBe(false);
    r.stop();
    expect(seen?.aborted).toBe(true);
  });
});
```

Import `GlossaryPassSummary` from `./glossary-extract.ts`.

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/gateway/src/glossary/glossary-refresh.test.ts > /tmp/t7.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t7.log
```

- [ ] **Step 3: Implement**

Rewrite `glossary-refresh.ts`, preserving the existing debounce / single-flight / dirty-rerun docstrings verbatim and adding:

```ts
import type { GlossaryPassSummary } from "./glossary-extract.ts";
import type { GlossaryPassProgress } from "./glossary-types.ts";

/** Carries `rpcCode` so `ipc/glossary-rpc.ts` maps it without re-deriving a code. */
export class GlossaryRefresherError extends Error {
  readonly rpcCode: number;
  constructor(message: string) {
    super(message);
    this.name = "GlossaryRefresherError";
    this.rpcCode = -32000;
  }
}

export type GlossaryRunOptions = {
  rebuild: boolean;
  onProgress?: (p: GlossaryPassProgress) => void;
};
```

Change `runPass` in `GlossaryRefresherDeps` to `(signal: AbortSignal, opts: GlossaryRunOptions) => Promise<GlossaryPassSummary>`, and add `runNow` + `status` to `GlossaryRefresher`.

Inside the factory, `fire()` becomes `deps.runPass(controller.signal, { rebuild: false })`. Add:

```ts
    status(): "idle" | "running" | "stopped" | "disabled" {
      if (stopped) return "stopped";
      if (!deps.enabled) return "disabled";
      return running ? "running" : "idle";
    },

    async runNow(o: GlossaryRunOptions): Promise<GlossaryPassSummary> {
      // Order matters: a disabled glossary is a config problem the user can
      // fix, a stopped one is not, and both are more useful answers than
      // "already running".
      if (!deps.enabled) {
        throw new GlossaryRefresherError(
          "ERR_GLOSSARY_DISABLED: the glossary is disabled — set [glossary].enabled = true in nimbus.toml",
        );
      }
      if (stopped) {
        throw new GlossaryRefresherError("ERR_GLOSSARY_STOPPED: the gateway is shutting down");
      }
      if (running) {
        // Deliberately NOT "await the in-flight pass and return its summary":
        // that pass is not the one the caller asked for, and for a rebuild it
        // would report success for work that never happened.
        throw new GlossaryRefresherError(
          "ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running",
        );
      }
      running = true;
      try {
        return await deps.runPass(controller.signal, o);
      } finally {
        running = false;
        // Preserve the scheduled path's dirty-rerun: a sync that landed during
        // this on-demand pass still gets its follow-up.
        if (dirty) {
          dirty = false;
          fire();
        }
      }
    },
```

Note the guards run **before any `await`**, so `status()` cannot go stale between an RPC check and the call.

- [ ] **Step 4: Update the assemble call site**

In `assemble.ts`, change the refresher's `runPass` to accept and honour the options, returning the summary:

```ts
    runPass: async (signal, runOpts) => {
      const passOpts = {
        maxNewTermsPerPass: glossaryCfg.maxNewTermsPerPass,
        statsRecheckPerPass: glossaryCfg.statsRecheckPerPass,
        statsRecheckCooldownMs: glossaryCfg.statsRecheckCooldownMs,
        minDocFreq: glossaryCfg.minDocFreq,
        consolidateTimeoutMs: glossaryCfg.consolidateTimeoutMs,
        retryBaseCooldownMs: glossaryCfg.retryBaseCooldownMs,
        ...(consolidationLlm === undefined ? {} : { llm: consolidationLlm }),
        ...(runOpts.onProgress === undefined ? {} : { onProgress: runOpts.onProgress }),
        nowMs: Date.now(),
        signal,
      };
      return runOpts.rebuild
        ? await rebuildGlossary(db, passOpts)
        : await runGlossaryPass(db, passOpts);
    },
```

Add `rebuildGlossary` to the existing import from `../glossary/glossary-extract.ts`.

- [ ] **Step 5: Run to verify they pass**

```bash
bun test packages/gateway/src/glossary packages/gateway/src/platform > /tmp/t7.log 2>&1; echo "EXIT=$?"; tail -8 /tmp/t7.log
```

- [ ] **Step 6: Red-prove**

Delete the `if (running)` guard. Re-run: the concurrent test FAILS (resolves instead of rejecting). Restore.
Change `deps.runPass(controller.signal, o)` to `deps.runPass(new AbortController().signal, o)`. Re-run: the abort-signal test FAILS (`seen.aborted` stays false after `stop()`). Restore, re-run green.

- [ ] **Step 7: Commit**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"
git add packages/gateway/src/glossary/glossary-refresh.ts packages/gateway/src/glossary/glossary-refresh.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(glossary): on-demand passes via refresher.runNow with single-flight"
```

---

## Task 8: The `glossary.*` IPC namespace

**Files:**

- Create: `packages/gateway/src/ipc/glossary-rpc.ts`
- Test: `packages/gateway/src/ipc/glossary-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (`FORBIDDEN_OVER_LAN`)
- Modify: `packages/gateway/src/ipc/server/options.ts:~127`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`
- Test: `packages/gateway/src/ipc/lan-rpc.test.ts`

**Interfaces:**

- Consumes: `GlossaryRefresher.runNow` / `.status` and `GlossaryRefresherError` (Task 7); `LongRunningJobRegistry` from `ipc/_lib/long-running.ts`; `dispatchByMethod` from `ipc/_lib/dispatch-by-method.ts`.
- Produces: `dispatchGlossaryRpc(method, params, ctx)`, `GlossaryRpcError`, `GlossaryRpcContext { refresher; notify }`. Task 9 wires the ctx; Task 10 calls the methods.

**Security — both halves are required:**

- **I5 / LAN:** `checkLanMethodAllowed` is a **denylist**. A new namespace is LAN-callable by default, so `"glossary"` MUST be added to `FORBIDDEN_OVER_LAN` — otherwise a paired peer can wipe the glossary or spend the owner's GPU. `agents.glossary` is unaffected (`agents` stays LAN-readable, like the other nine agents).
- **I7 / Tauri:** do **not** touch `ALLOWED_METHODS`. It stays at 102.

`scripts/structure-audit/check-nimbus-invariants.ts` has **no rule keyed on `glossary/` or on `ipc/*-rpc.ts`** — its only `ipc/` entries are D21's confinement of `share-rpc.ts` and `federation-rpc.ts`. Nothing static will catch a dropped LAN entry, which makes the `lan-rpc.test.ts` assertion the sole guard. Treat it as required.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/ipc/glossary-rpc.test.ts`:

```ts
import { describe, expect, it } from "bun:test";

import type { GlossaryPassSummary } from "../glossary/glossary-extract.ts";
import { GlossaryRefresherError, type GlossaryRefresher } from "../glossary/glossary-refresh.ts";
import { dispatchGlossaryRpc, GlossaryRpcError } from "./glossary-rpc.ts";

const SUMMARY: GlossaryPassSummary = {
  scanned: 1, discovered: 2, demoted: 0, consolidated: 3, upgraded: 1, vetoed: 0,
  upgradesVetoed: 0, vetoedTerms: [], retried: 0, llmConfigured: true,
  llmProduced: true, aborted: false,
};

function fakeRefresher(over: Partial<GlossaryRefresher> = {}): GlossaryRefresher {
  return {
    trigger: () => undefined,
    stop: () => undefined,
    status: () => "idle",
    runNow: () => Promise.resolve(SUMMARY),
    ...over,
  };
}

function collector() {
  const seen: Array<{ method: string; params: unknown }> = [];
  return { seen, notify: (method: string, params: unknown) => { seen.push({ method, params }); } };
}

describe("dispatchGlossaryRpc", () => {
  it("misses on an unrelated method", async () => {
    const out = await dispatchGlossaryRpc("agents.glossary", {}, {
      refresher: fakeRefresher(), notify: () => undefined,
    });
    expect(out.kind).toBe("miss");
  });

  it("glossary.refresh returns a jobId and emits passDone", async () => {
    const c = collector();
    const ctx = { refresher: fakeRefresher(), notify: c.notify };
    const out = await dispatchGlossaryRpc("glossary.refresh", {}, ctx);
    expect(out.kind).toBe("hit");
    expect((out as { value: { jobId: string } }).value.jobId).toStartWith("glossary_refresh_");
    await Bun.sleep(10);
    const done = c.seen.find((n) => n.method === "glossary.passDone");
    expect(done).toBeDefined();
    expect((done?.params as { upgraded: number }).upgraded).toBe(1);
  });

  it("glossary.rebuild forwards rebuild: true", async () => {
    let sawRebuild: boolean | undefined;
    const ctx = {
      refresher: fakeRefresher({
        runNow: (o) => { sawRebuild = o.rebuild; return Promise.resolve(SUMMARY); },
      }),
      notify: () => undefined,
    };
    await dispatchGlossaryRpc("glossary.rebuild", {}, ctx);
    await Bun.sleep(10);
    expect(sawRebuild).toBe(true);
  });

  // A concurrent request must be an immediate RPC ERROR, not a jobId whose
  // passError arrives later — the caller would otherwise think it started.
  it("rejects synchronously when a pass is already running", async () => {
    const ctx = { refresher: fakeRefresher({ status: () => "running" }), notify: () => undefined };
    await expect(dispatchGlossaryRpc("glossary.refresh", {}, ctx)).rejects.toThrow(
      "ERR_GLOSSARY_PASS_RUNNING",
    );
  });

  it("rejects when the glossary is disabled", async () => {
    const ctx = { refresher: fakeRefresher({ status: () => "disabled" }), notify: () => undefined };
    await expect(dispatchGlossaryRpc("glossary.refresh", {}, ctx)).rejects.toBeInstanceOf(
      GlossaryRpcError,
    );
  });

  it("emits passError when the pass throws", async () => {
    const c = collector();
    const ctx = {
      refresher: fakeRefresher({
        runNow: () => Promise.reject(new GlossaryRefresherError("ERR_BOOM: nope")),
      }),
      notify: c.notify,
    };
    await dispatchGlossaryRpc("glossary.refresh", {}, ctx);
    await Bun.sleep(10);
    const err = c.seen.find((n) => n.method === "glossary.passError");
    expect((err?.params as { code: number }).code).toBe(-32000);
  });
});
```

Append to `packages/gateway/src/ipc/lan-rpc.test.ts`:

```ts
it("forbids the glossary namespace over LAN", () => {
  const peer = { peerId: "p1", writeAllowed: true };
  expect(() => checkLanMethodAllowed("glossary.refresh", peer)).toThrow("not callable over LAN");
  expect(() => checkLanMethodAllowed("glossary.rebuild", peer)).toThrow("not callable over LAN");
  // The read-only agent stays reachable, like the other nine agents.
  expect(() => checkLanMethodAllowed("agents.glossary", peer)).not.toThrow();
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
bun test packages/gateway/src/ipc/glossary-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts > /tmp/t8.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t8.log
```

- [ ] **Step 3: Write the RPC module**

Create `packages/gateway/src/ipc/glossary-rpc.ts`:

```ts
import type { GlossaryRefresher } from "../glossary/glossary-refresh.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export type GlossaryRpcContext = {
  refresher: GlossaryRefresher;
  notify: (method: string, params: unknown) => void;
};

export class GlossaryRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "GlossaryRpcError";
    this.rpcCode = rpcCode;
  }
}

const registry = new LongRunningJobRegistry();

/**
 * A pass runs up to `max_new_terms_per_pass * consolidate_timeout_ms` — 12.5
 * minutes at defaults — so both methods are long-running jobs rather than
 * blocking calls, following the `index.reembed` precedent.
 *
 * The precondition is checked SYNCHRONOUSLY here rather than being left to
 * `runNow`'s own guards: a caller who gets `{ jobId }` back reasonably believes
 * a pass started, so "already running" has to surface as an RPC error, not as a
 * `passError` notification arriving afterwards. `status()` cannot go stale
 * between this check and `runNow`'s prologue — neither awaits.
 */
function startPass(ctx: GlossaryRpcContext, rebuild: boolean): { jobId: string } {
  const status = ctx.refresher.status();
  if (status === "disabled") {
    throw new GlossaryRpcError(
      -32000,
      "ERR_GLOSSARY_DISABLED: the glossary is disabled — set [glossary].enabled = true in nimbus.toml",
    );
  }
  if (status === "stopped") {
    throw new GlossaryRpcError(-32000, "ERR_GLOSSARY_STOPPED: the gateway is shutting down");
  }
  if (status === "running") {
    throw new GlossaryRpcError(
      -32000,
      "ERR_GLOSSARY_PASS_RUNNING: a glossary pass is already running",
    );
  }
  return registry.start({
    jobIdPrefix: rebuild ? "glossary_rebuild" : "glossary_refresh",
    progressMethod: "glossary.passProgress",
    doneMethod: "glossary.passDone",
    errorMethod: "glossary.passError",
    emit: (m, payload) => {
      ctx.notify(m, payload);
    },
    // The refresher owns its own AbortSignal (aborted by `stop()` at shutdown),
    // so the registry's per-job signal is deliberately unused.
    run: (progress) =>
      ctx.refresher.runNow({
        rebuild,
        onProgress: (p) => {
          progress({ ...p });
        },
      }),
  });
}

export async function dispatchGlossaryRpc(
  method: string,
  params: unknown,
  ctx: GlossaryRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<GlossaryRpcContext>(method, params, ctx, {
    "glossary.refresh": (_p, c) => startPass(c, false),
    "glossary.rebuild": (_p, c) => startPass(c, true),
  });
}
```

Check `dispatchByMethod`'s exported result type name in `ipc/_lib/dispatch-by-method.ts` and match it (`agents-rpc.ts` and `index-reembed-rpc.ts` both import it — copy whichever name they use).

- [ ] **Step 4: Add the LAN denylist entry**

In `packages/gateway/src/ipc/lan-rpc.ts`, inside `FORBIDDEN_OVER_LAN`, next to the `index.reembed` entries:

```ts
  // Glossary on-demand passes are write-class and local-only: refresh spends the
  // owner's local model, rebuild TRUNCATES both glossary tables and deletes every
  // projected item. The denylist is default-allow, so omitting this would leave a
  // paired peer able to wipe the glossary. The read-only `agents.glossary` stays
  // admitted, like every other agent.
  "glossary",
```

- [ ] **Step 5: Wire the dispatcher**

In `packages/gateway/src/ipc/server/options.ts`, beside `egressRpcCtx`:

```ts
  glossaryRefresher?: GlossaryRefresher;
```

with the type import. In `packages/gateway/src/ipc/server/dispatchers.ts`, add the import and a handler modelled on `tryDispatchEgressRpc`:

```ts
export async function tryDispatchGlossaryRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
): Promise<unknown> {
  if (!method.startsWith("glossary.")) return phase4RpcSkipped;
  const refresher = ctx.options.glossaryRefresher;
  if (refresher === undefined) return phase4RpcSkipped;
  try {
    const out = await dispatchGlossaryRpc(method, params, {
      refresher,
      notify: (m, p) => ctx.broadcastNotification(m, p as Record<string, unknown>),
    });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof GlossaryRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

Register it in the same dispatch chain that calls `tryDispatchEgressRpc` (~`:1057`), following the surrounding `phase4RpcSkipped` convention exactly.

- [ ] **Step 6: Run to verify they pass**

```bash
bun test packages/gateway/src/ipc > /tmp/t8.log 2>&1; echo "EXIT=$?"; tail -8 /tmp/t8.log
```

- [ ] **Step 7: Red-prove the LAN block and the sync rejection**

Remove `"glossary",` from `FORBIDDEN_OVER_LAN`. Re-run: the LAN test FAILS (no throw). Restore.
Delete the `if (status === "running")` block. Re-run: "rejects synchronously" FAILS (resolves to a `{ jobId }` hit). Restore, re-run green.

- [ ] **Step 8: Confirm I7 is untouched, then commit**

```bash
grep -n "ALLOWED_METHODS.len(), 102" packages/ui/src-tauri/src/gateway_bridge.rs
grep -rn "glossary" packages/ui/src-tauri/src/gateway_bridge.rs
```

Expected: the count assertion still reads 102, and the ONLY glossary hit is the pre-existing `agents.glossary`.

```bash
bun test packages/gateway/src/security-invariants.test.ts > /tmp/inv.log 2>&1; echo "EXIT=$?"
git add packages/gateway/src/ipc/ packages/gateway/src/ipc/server/
git commit -m "feat(glossary): glossary.refresh / glossary.rebuild IPC, LAN-forbidden"
```

---

## Task 9: Expose the refresher to the IPC server

**Files:**

- Modify: `packages/gateway/src/platform/assemble.ts:1768`

**Interfaces:**

- Consumes: `glossaryRefresher` (already returned by `createSchedulerWithMesh`), `ipcOpts.glossaryRefresher` (Task 8).

- [ ] **Step 1: Assign it onto `ipcOpts`**

`glossaryRefresher` is already destructured at `:1758` and registered for shutdown at `:1768`. `ipcOpts` is built at `:1781`. Add, immediately after the `ipcOpts` object literal is constructed:

```ts
  ipcOpts.glossaryRefresher = glossaryRefresher;
```

matching the `ipcOpts.egressRpcCtx = egressRpcCtx;` style at `:2081`.

- [ ] **Step 2: Typecheck and verify by reading**

```bash
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"
grep -n "glossaryRefresher" packages/gateway/src/platform/assemble.ts
```

Expected three hits: the destructure, the `sidecarStops.push`, and the new `ipcOpts` assignment.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/platform/assemble.ts
git commit -m "feat(glossary): expose the refresher to the IPC server"
```

---

## Task 10: CLI `--refresh` / `--rebuild` / `--yes`

**Files:**

- Modify: `packages/cli/src/commands/_agent-brief-cli.ts` (add `beforeCall`)
- Modify: `packages/cli/src/commands/glossary.ts` (replace `UNWIRED_FLAGS`)
- Test: `packages/cli/src/commands/glossary.test.ts`

**Interfaces:**

- Consumes: `glossary.refresh` / `glossary.rebuild` and the `glossary.pass*` notifications (Task 8); the summary fields from Task 5.
- Produces: user-facing CLI behaviour only.

**Placement of `beforeCall` is load-bearing:** it must run **before** `awaitBrief` arms its 30 s timer, or a 12-minute pass trips the brief timeout. A second `IPCClient` would instead duplicate the gateway-not-running and exit-code handling this helper exists to own.

**Do not copy the jobId filter from `index-cmd.ts`.** That precedent registers handlers, then assigns `jobId` in a `.then()`, and drops any notification arriving before the assignment. The glossary refresher is single-flight, so at most one job can be in flight — resolve on the first `passDone` and skip the filter entirely. Filtering would introduce a race that does not need to exist here.

- [ ] **Step 1: Add the `beforeCall` hook**

In `_agent-brief-cli.ts`, add to `AgentBriefCliSpec`:

```ts
  /**
   * Runs after connect, BEFORE the brief-notification timer is armed. Used by
   * `glossary --refresh` to drive a pass that can take minutes; arming the 30 s
   * brief timeout first would kill it.
   */
  beforeCall?: (client: IPCClient) => Promise<void>;
```

and in `runAgentBriefCli`, between `registerInteractiveCliIpcHandlers(client);` and `const briefPromise = awaitBrief(...)`:

```ts
    if (spec.beforeCall !== undefined) await spec.beforeCall(client);
```

- [ ] **Step 2: Write the failing CLI tests**

Append to `packages/cli/src/commands/glossary.test.ts` (DI, never `mock.module`):

```ts
describe("glossary flag parsing", () => {
  it("parses --refresh", () => {
    expect(parseGlossaryArgs(["--refresh"]).refresh).toBe(true);
  });

  it("parses --rebuild and --yes independently", () => {
    const a = parseGlossaryArgs(["--rebuild"]);
    expect(a.rebuild).toBe(true);
    expect(a.yes).toBe(false);
    const b = parseGlossaryArgs(["--rebuild", "--yes"]);
    expect(b.rebuild).toBe(true);
    expect(b.yes).toBe(true);
  });

  it("rejects --refresh together with --rebuild", () => {
    expect(() => parseGlossaryArgs(["--refresh", "--rebuild"])).toThrow("cannot be combined");
  });
});

describe("renderPassOutcome", () => {
  const BASE = {
    scanned: 0, discovered: 0, demoted: 0, consolidated: 2, upgraded: 0, vetoed: 0,
    upgradesVetoed: 0, vetoedTerms: [] as string[], retried: 0,
    llmConfigured: false, llmProduced: false, aborted: false,
  };

  it("warns when a model was configured but produced nothing", () => {
    const lines = renderPassOutcome({ ...BASE, llmConfigured: true, llmProduced: false });
    expect(lines.join("\n")).toContain("no local LLM provider was available");
  });

  it("does not warn when no model was configured at all", () => {
    expect(renderPassOutcome(BASE).join("\n")).not.toContain("no local LLM provider");
  });

  it("does not warn when the model produced definitions", () => {
    const lines = renderPassOutcome({ ...BASE, llmConfigured: true, llmProduced: true });
    expect(lines.join("\n")).not.toContain("no local LLM provider");
  });

  it("names terms vetoed during an upgrade", () => {
    const lines = renderPassOutcome({
      ...BASE, upgradesVetoed: 2, vetoedTerms: ["cdr", "slo"],
    });
    expect(lines.join("\n")).toContain("cdr, slo");
    expect(lines.join("\n")).toContain("no longer in the glossary");
  });
});

describe("renderRebuildPreview", () => {
  it("lists a sample and the remainder", () => {
    const out = renderRebuildPreview(
      { total: 47, pending: 12 },
      ["CDR", "shard_key", "write-behind"],
    );
    expect(out).toContain("47 consolidated terms and 12 pending candidates");
    expect(out).toContain("CDR, shard_key, write-behind");
    expect(out).toContain("--yes");
  });

  it("omits the remainder line when the sample covers everything", () => {
    const out = renderRebuildPreview({ total: 2, pending: 0 }, ["CDR", "SLO"]);
    expect(out).not.toContain("more");
  });
});
```

- [ ] **Step 3: Run to verify they fail**

```bash
bun test packages/cli/src/commands/glossary.test.ts > /tmp/t10.log 2>&1; echo "EXIT=$?"; tail -20 /tmp/t10.log
```

- [ ] **Step 4: Implement the CLI**

In `packages/cli/src/commands/glossary.ts`: delete `UNWIRED_FLAGS` and its docstring; extend `GlossaryCliArgs` with `refresh: boolean; rebuild: boolean; yes: boolean;`; update `USAGE`:

```ts
const USAGE =
  "Usage: nimbus glossary [<term>] [--limit <n>] [--json] [--refresh | --rebuild [--yes]]";
```

Parse the three flags in the existing loop (`else if (a === "--refresh") refresh = true;` etc.), and after the loop:

```ts
  if (refresh && rebuild) {
    throw new Error(`--refresh and --rebuild cannot be combined\n${USAGE}`);
  }
```

Add the two pure renderers (pure so they are testable without a gateway):

```ts
export type GlossaryPassSummaryLike = {
  consolidated: number;
  upgraded: number;
  upgradesVetoed: number;
  vetoedTerms: string[];
  llmConfigured: boolean;
  llmProduced: boolean;
};

const REBUILD_SAMPLE = 10;

/**
 * Post-pass lines.
 *
 * The warning fires only on `llmConfigured && !llmProduced`: "no model
 * configured" is a choice, "a model was configured and never answered" is
 * Ollama not running — and only the second is worth interrupting the user for.
 */
export function renderPassOutcome(s: GlossaryPassSummaryLike): string[] {
  const lines = [
    `Pass complete: ${String(s.consolidated)} new, ${String(s.upgraded)} upgraded.`,
  ];
  if (s.llmConfigured && !s.llmProduced && s.consolidated + s.upgraded > 0) {
    lines.push(
      "Warning: no local LLM provider was available — terms were consolidated from raw snippets.",
    );
  }
  if (s.upgradesVetoed > 0) {
    lines.push(
      `Vetoed ${String(s.upgradesVetoed)} previously snippet-defined term(s): ` +
        `${s.vetoedTerms.join(", ")} (no longer in the glossary).`,
    );
  }
  return lines;
}

/** A count says how much is lost; the sample says WHAT. Sorted by score upstream, so these are the terms most likely to be recognised. */
export function renderRebuildPreview(
  counts: { total: number; pending: number },
  sample: readonly string[],
): string {
  const lines = [
    `${String(counts.total)} consolidated terms and ${String(counts.pending)} pending ` +
      "candidates would be deleted.",
  ];
  if (sample.length > 0) lines.push(`  ${sample.join(", ")}`);
  const remainder = counts.total - sample.length;
  if (remainder > 0) lines.push(`  ... and ${String(remainder)} more`);
  lines.push("Re-run with --yes to confirm.");
  return lines.join("\n");
}
```

Drive the pass from `runGlossaryCommand` via `beforeCall`:

```ts
function awaitPass(client: IPCClient, method: string): Promise<GlossaryPassSummaryLike> {
  return new Promise((resolve, reject) => {
    // Single-flight in the gateway guarantees at most one job, so there is no
    // jobId to filter on — and filtering would race the `{ jobId }` reply.
    client.onNotification("glossary.passProgress", (n: unknown) => {
      const p = n as { done: number; total: number };
      process.stderr.write(`  consolidating ${String(p.done)}/${String(p.total)}\r`);
    });
    client.onNotification("glossary.passDone", (n: unknown) => {
      resolve(n as GlossaryPassSummaryLike);
    });
    client.onNotification("glossary.passError", (n: unknown) => {
      reject(new Error((n as { message: string }).message));
    });
    client.call<{ jobId: string }>(method, {}).catch(reject);
  });
}
```

and in `runGlossaryCommand`, when `parsed.rebuild && !parsed.yes`, print `renderRebuildPreview(...)` from an `agents.glossary` read and return **without** calling either mutating method; otherwise set `beforeCall` to run `awaitPass` and print `renderPassOutcome`.

- [ ] **Step 5: Run to verify they pass**

```bash
bun test packages/cli/src/commands/glossary.test.ts > /tmp/t10.log 2>&1; echo "EXIT=$?"; tail -8 /tmp/t10.log
bun test packages/cli/src > /tmp/t10b.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/t10b.log
```

- [ ] **Step 6: Red-prove the warning condition**

Change the warning guard to `if (!s.llmProduced …)` (dropping `llmConfigured`). Re-run: "does not warn when no model was configured at all" FAILS. Restore, re-run green.

- [ ] **Step 7: Update `nimbus help` and the command registry if needed**

```bash
grep -n "glossary" packages/cli/src/commands/help.ts packages/cli/src/registry.ts
```

`glossary` is already listed in both (added late in the base slice). Update the help one-liner only if it mentions the flags.

- [ ] **Step 8: Commit**

```bash
bunx tsc --noEmit -p packages/cli/tsconfig.json > /tmp/tsc.log 2>&1; echo "TSC=$?"
git add packages/cli/src/commands/
git commit -m "feat(glossary): wire nimbus glossary --refresh and --rebuild"
```

---

## Task 11: E2E smoke coverage

**Files:**

- Modify: `packages/cli/test/e2e/glossary.smoke.e2e.test.ts`

**Interfaces:**

- Consumes: the CLI from Task 10.

The existing file asserts that `--rebuild` is **rejected**. That assertion is now false and must be replaced, not deleted.

- [ ] **Step 1: Add a local spawn helper**

The file has no `runCli` helper — every case inlines `Bun.spawn` with `emptyEnvOverrides()`, and it uses `test`, not `it`. Three new cases would triple that boilerplate, so add one helper beside `emptyEnvOverrides` and use it for the new cases only (leave the existing two cases alone — rewriting them is out of scope):

```ts
async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", cliEntry, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...emptyEnvOverrides() },
  });
  const code = await proc.exited;
  return {
    code,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}
```

`cliEntry` is already defined inside the `describe`, so declare `runCli` inside it too.

- [ ] **Step 2: Replace the rejection assertion**

Delete the existing `test("--rebuild fails with an explicit not-implemented error, not a silent query", ...)` case — its premise is now false — and add:

```ts
  test("--rebuild without --yes fails only for want of a gateway, not for being unwired", async () => {
    const out = await runCli(["glossary", "--rebuild"]);
    // No gateway in the smoke env, so it exits on that. The point of the
    // assertion is the ABSENCE of the old "not implemented yet" rejection.
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain("Gateway is not running");
    expect(out.stderr).not.toContain("not implemented");
  });

  test("--refresh and --rebuild appear in the usage line", async () => {
    const out = await runCli(["glossary", "--help"]);
    const text = out.stdout + out.stderr;
    expect(text).toContain("--refresh");
    expect(text).toContain("--rebuild");
  });

  test("rejects --refresh combined with --rebuild before reaching the gateway", async () => {
    const out = await runCli(["glossary", "--refresh", "--rebuild"]);
    expect(out.stderr).toContain("cannot be combined");
    expect(out.stderr).not.toContain("Gateway is not running");
  });
```

The last assertion in each of the first and third cases is what makes them discriminating: without them, both pass against the old unwired CLI too.

- [ ] **Step 3: Run**

```bash
bun test packages/cli/test/e2e/glossary.smoke.e2e.test.ts > /tmp/t11.log 2>&1; echo "EXIT=$?"; tail -10 /tmp/t11.log
```

- [ ] **Step 4: Commit**

```bash
git add packages/cli/test/e2e/glossary.smoke.e2e.test.ts
git commit -m "test(glossary): e2e smoke for the wired refresh/rebuild flags"
```

---

## Task 12: Documentation

**Files:**

- Modify: `docs/superpowers/specs/2026-07-30-nimbus-glossary-design.md` (§1, §5.7, §7, §12, §14)
- Modify: `docs/roadmap.md` (~`:1072`, ~`:1106`)
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/architecture.md` (IPC method catalogue)

No schema change, so `docs/schema-reference.md` is untouched. `CLAUDE.md` / `GEMINI.md` need no status-line change (schema stays V45).

- [ ] **Step 1: Find every citation before editing**

```bash
grep -rn "\-\-refresh\|--rebuild" docs/ packages/ --include=*.md --include=*.ts | grep -v node_modules
grep -rn "no automatic upgrade\|snippet-sourced\|definition_source" docs/ | grep -v node_modules
```

The base slice found a shipped string this way that no doc list had named. Work from the grep output, not from memory.

- [ ] **Step 2: Correct the base spec**

- §1 usage block — delete the parenthetical saying both flags are parsed but not honoured; add them to the usage examples.
- §5.7 — replace "**No automatic upgrade path exists**" with the §3 upgrade path, and drop "the scheduler-triggered pass itself also runs with no `llm` supplied"; keep the no-LLM-configured degradation, which is unchanged.
- §7 — add `use_llm` to the config block; replace the two flag paragraphs.
- §12 — delete the `--refresh`/`--rebuild` limit and rewrite the veto-stickiness entry (rebuild now works). Add the un-propagated abort signal.
- §14 — unscope the LLM acceptance criterion; the scheduler path now uses a model.

- [ ] **Step 3: Roadmap, changelog, CLI reference, architecture**

- `roadmap.md:1072` — the surviving auto-upgrade claim.
- `roadmap.md:1106` — the LLM-consolidation criterion may now be ticked honestly.
- `docs/CHANGELOG.md` — one dated entry under today's date covering all three follow-ups, including the surprising consequence that enabling the LLM can remove snippet terms.
- `docs/cli-reference.md` — `--refresh`, `--rebuild`, `--yes`, and that veto-on-upgrade consequence.
- `docs/architecture.md` — add `glossary.refresh` / `glossary.rebuild` and the three `glossary.pass*` notifications to the IPC catalogue; note both are LAN-forbidden and not Tauri-exposed.

- [ ] **Step 4: Lint the docs by explicit path**

The markdownlint globs exclude `.claude/worktrees/**`, so the repo script silently skips everything here.

```bash
bunx markdownlint-cli2 docs/superpowers/specs/*.md docs/*.md > /tmp/mdl.log 2>&1; echo "MDL=$?"; tail -5 /tmp/mdl.log
bun run audit:doc-refs > /tmp/dr.log 2>&1; echo "DOCREFS=$?"
bun run audit:readme-cli > /tmp/rc.log 2>&1; echo "READMECLI=$?"
```

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "docs(glossary): record the LLM wiring, upgrade path and wired flags"
```

---

## Task 13: Full pre-flight

- [ ] **Step 1: Static gates**

```bash
bunx biome check packages scripts > /tmp/g1.log 2>&1; echo "BIOME=$?"
bunx tsc --noEmit -p packages/gateway/tsconfig.json > /tmp/g2.log 2>&1; echo "TSC_GW=$?"
bunx tsc --noEmit -p packages/cli/tsconfig.json > /tmp/g3.log 2>&1; echo "TSC_CLI=$?"
bun run audit:invariants > /tmp/g4.log 2>&1; echo "INV=$?"
bun run audit:any --check > /tmp/g5.log 2>&1; echo "ANY=$?"
```

`audit:any` **without** `--check` always exits 0 — a false pass. It also counts `any` inside a `/** */` docstring when that docstring contains a backtick (the comment stripper treats the backtick as entering a template string). If it names a file whose only `any` is prose, reword the comment.

- [ ] **Step 2: Suites**

```bash
bun test packages/gateway/src > /tmp/s1.log 2>&1; echo "GW_SRC=$?"; tail -3 /tmp/s1.log
bun test packages/gateway/test > /tmp/s2.log 2>&1; echo "GW_TEST=$?"; tail -3 /tmp/s2.log
bun test packages/cli/src > /tmp/s3.log 2>&1; echo "CLI_SRC=$?"; tail -3 /tmp/s3.log
```

Known environmental (NOT branch-caused, load-dependent): 3 `packages/cli/src/tui/dumb-terminal.test.ts` timeouts and `updater/wiring.test.ts`. Both were proven environmental in the base slice by running them on the untouched main checkout. If anything else fails, it is yours.

- [ ] **Step 3: Coverage floor — Docker, the only authoritative source**

```bash
bash scripts/coverage-floor/reseed-docker.sh > /tmp/cov.log 2>&1; echo "COV=$?"; tail -30 /tmp/cov.log
```

~8 minutes. A run reporting ~985 source files is real; ~199 is a broken run, not a result. `glossary-llm-adapter.ts` and `glossary-rpc.ts` are new source files and must each clear ≥80% line **and** branch. Fix shortfalls with tests, never exclusions. If a branch is genuinely unreachable because `noUncheckedIndexedAccess` forces a `??` fallback, restructure the code to remove the dead branch rather than excluding the file.

- [ ] **Step 4: Full preflight**

```bash
bun run preflight > /tmp/pf.log 2>&1; echo "PREFLIGHT=$?"; tail -40 /tmp/pf.log
```

If the only failure is `lint (biome)` reporting "Checked 0 files", that is the documented worktree path artifact — confirm with `bunx biome check packages scripts` and treat Step 1's result as authoritative. Preflight fail-fasts, so run any gates after the failing one individually.

- [ ] **Step 5: Final commit**

```bash
git add -u
git commit -m "chore(glossary): pre-flight fixes"
```

Never `git add -A` — `.claude/settings.local.json` is git-tracked in this repo.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §2.1–2.2 local-only adapter, `isLocalProviderKind`, summarisation task | 1 |
| §2.3 signal accepted, not propagated | 1 (adapter), 12 (limit recorded) |
| §2.4 `SchedulerWithMeshOpts.glossaryLlm` | 3 |
| §2.5 `use_llm` | 2 (config), 3 (gate) |
| §2.6 gap note + `--refresh` warning | 6 (note), 5 (`llmConfigured`/`llmProduced`), 10 (warning) |
| §3.1 `selectSnippetUpgradeBatch` | 4 |
| §3.2 reserve, no migration, retry preserves, veto honoured + reported, no attempt cap | 4, 5 |
| §3.3 summary fields | 5 |
| §4.1 new namespace not agent params | 8 |
| §4.2 single-flight, `-32000` codes, no `--force` | 7, 8 |
| §4.3 long-running job + progress | 5 (`onProgress`), 8 (registry) |
| §4.4 `beforeCall`, flags, preview | 10 |
| §4.5 LAN denylist, Tauri untouched | 8 |
| §5 test table | 1, 4, 5, 6, 7, 8, 10, 11 |
| §6 doc claims | 12 |
| §7 known limits | 12 |
| §8 acceptance | 13 |

**Type consistency:** `GlossaryPassSummary` gains exactly `upgraded`, `upgradesVetoed`, `vetoedTerms`, `llmConfigured`, `llmProduced` in Task 5 and is consumed with those names in Tasks 7, 8, 10, 11. `GlossaryRunOptions { rebuild; onProgress? }` is defined in Task 7 and used identically in Task 8. `GlossaryPassProgress` is defined in Task 5 and consumed in 7, 8, 10. `createGlossaryLlm` / `isLocalProviderKind` are defined in Task 1 and consumed in Task 3.

**Known gap, deliberate:** Task 3 has no dedicated unit test — `createSchedulerWithMesh` needs a full platform to construct, and a test asserting only "the option is passed through" would be a tautology. Its behaviour is covered by Task 5's integration tests (which exercise `runGlossaryPass` with a real `llm`) plus `tsc` and the grep verification in Task 3 Step 4. Flagged rather than papered over.
