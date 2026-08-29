# Embedding Egress Ledger + Per-Task Model Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close invariant I29's last `model`-class exclusion by ledgering remote embeddings, then let `[llm.tasks]` pin a model per task type so a 3B model classifies while a 14B model reasons.

**Architecture:** Part A applies the decorator shape I29 already uses for LLM routes — `wrapLedgeredProvider` at `LlmRegistry.addRoute` — to embedders, wrapping at construction so no call site cooperates. Locality is DERIVED from a new `Embedder.isLocal`, never passed by the caller. Part B adds the `[llm.tasks]` config surface, teaches `LlmRouter.selectRoute` to honour a pin, and adds `nimbus llm use` — which writes **that same TOML table**, not a second store. `llm_task_defaults` (V20) and its `setDefault`/`getDefault` accessors, which nothing has ever read, are RETIRED rather than revived: see Review Response 1.

**Tech Stack:** Bun 1.2+, TypeScript strict, bun:sqlite, Biome. No new dependencies.

**Spec:** No separate spec doc. The authority is `docs/roadmap.md` § Active → Spine S2, row *"Bring-your-own-frontier-model routing with local fallback"*, whose **Still open** clause names both halves: *"`[llm.tasks]` per-task pinning and `nimbus llm use` (slice 4) … and an embeddings appender — embeddings remain I29's one `model`-class exclusion."* Invariant text: `docs/SECURITY-INVARIANTS.md` § I29.

## Global Constraints

- **Neither part is a BREAKING change.** Part A adds a ledger row; Part B adds an optional config key and a new subcommand. No existing config stops working, no user must act. PR titles are `feat(egress):` and `feat(llm):` — **not** `feat!`. `main` burned four majors in two days on changes like these; see `CLAUDE.md` § Development Workflow.
- **No `any`.** Use `unknown` for external data (non-negotiable #7).
- **The appender must DERIVE locality, never be told it.** `wrapLedgeredProvider` reads `provider.isLocal`; this mirrors it. A caller-passed boolean is one wiring mistake away from a fabricated or missing row.
- **Fail-closed.** An append failure aborts the embed call, exactly as `EgressAppendFailedError` aborts a generate.
- **Every invariant change lands wiring + `docs/SECURITY-INVARIANTS.md` + an enforcement test in `security-invariants.test.ts` in the SAME commit** (the triple rule).
- **`CLAUDE.md` and `GEMINI.md` mirror each other** — update both or neither.
- Verify with `bun run preflight:fast`, then the CI command verbatim: `bun test packages/gateway packages/cli scripts`. `typecheck:tests` is **advisory on win32** — read its output, not its exit code.

---

## File Structure

**Part A — embedding egress**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/embedding/types.ts` | MODIFY — add `isLocal: boolean` to `Embedder` |
| `packages/gateway/src/egress/embedding-egress.ts` | CREATE — `wrapLedgeredEmbedder`, the sole appender |
| `packages/gateway/src/egress/embedding-egress.test.ts` | CREATE — behaviour of the wrapper |
| `packages/gateway/src/embedding/openai-embedder.ts` | MODIFY — declare `isLocal = false` |
| `packages/gateway/src/embedding/local-embedder.ts` (and siblings) | MODIFY — declare `isLocal = true` |
| `packages/gateway/src/embedding/create-routing-runtime.ts:48` | MODIFY — wrap at construction |
| `packages/gateway/src/embedding/create-embedding-runtime.ts:173` | MODIFY — wrap at construction |
| `packages/gateway/src/ipc/index-reembed-rpc.ts:101` | MODIFY — wrap at construction |
| `packages/gateway/src/egress/egress-coverage.ts` | MODIFY — `model` class note; embeddings no longer excluded |
| `scripts/structure-audit/check-nimbus-invariants.ts` | MODIFY — D22 rule (f): confine `wrapLedgeredEmbedder` |
| `packages/gateway/src/security-invariants.test.ts` | MODIFY — I29 enforcement test |
| `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` | MODIFY — I29 text |

**Part B — per-task routing**

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/config/nimbus-toml.ts` | MODIFY — parse `[llm.tasks]` |
| `packages/gateway/src/llm/router.ts` | MODIFY — `taskPins` in config; honour in `selectRoute` |
| `packages/gateway/src/llm/registry.ts` | MODIFY — DELETE the dead `setDefault`/`getDefault` |
| `packages/gateway/src/platform/assemble.ts` | MODIFY — thread `[llm.tasks]` into `LlmRouterConfig` |
| `packages/gateway/src/ipc/llm-rpc.ts` | MODIFY — `llm.use` method |
| `packages/cli/src/commands/llm.ts` | MODIFY — `nimbus llm use <task> <routeId>` |
| `docs/cli-reference.md` | MODIFY — document both surfaces |

---

## Part A — Embedding Egress Ledger

### Task 1: `Embedder.isLocal`, declared per implementation

**Files:**

- Modify: `packages/gateway/src/embedding/types.ts`
- Modify: `packages/gateway/src/embedding/openai-embedder.ts`
- Modify: every other file returning an `Embedder` (find with `git grep -ln "): Promise<Embedder>" packages/gateway/src`)

**Interfaces:**

- Produces: `Embedder.isLocal: boolean` — read by `wrapLedgeredEmbedder` in Task 2.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/embedding/embedder-locality.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { createOpenAIEmbedder } from "./openai-embedder.ts";

describe("Embedder locality is declared, not inferred", () => {
  test("the OpenAI embedder is NOT local", async () => {
    // Hardcoded false, never derived from a base URL: the same rule I34 pins for cloud LLM
    // adapters. An embedder that claims to be local appends no ledger row, so a wrong `true`
    // is silent in exactly the direction that matters.
    const e = await createOpenAIEmbedder({ apiKey: "sk-test" });
    expect(e.isLocal).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test packages/gateway/src/embedding/embedder-locality.test.ts
```

Expected: FAIL — `isLocal` does not exist on `Embedder`.

- [ ] **Step 3: Add the field**

In `types.ts`, add to the `Embedder` interface:

```ts
  /**
   * Whether embedding runs ON this machine. DECLARED by each implementation, never inferred
   * from a URL by a caller: `egress/embedding-egress.ts` reads this to decide whether a batch
   * appends an `egress_ledger` row, and a wrong `true` is silent — no row, no error, and
   * `nimbus prove` reports a clean zero over real outbound traffic. Same contract as
   * `LlmProvider.isLocal` (invariant I34).
   */
  readonly isLocal: boolean;
```

In `openai-embedder.ts`, add `isLocal: false,` to the returned object, next to `model` and `dims`.

- [ ] **Step 4: Fix every other implementation**

`bun run typecheck` now lists every file returning an `Embedder`. Add `isLocal: true` to each local one (MiniLM / ONNX / stub). If any implementation is genuinely remote, it gets `false`.

- [ ] **Step 5: Verify**

```bash
bun run typecheck
bun test packages/gateway/src/embedding
```

Expected: typecheck clean, all embedding tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/embedding
git commit -m "feat(embedding): declare Embedder.isLocal per implementation"
```

---

### Task 2: `wrapLedgeredEmbedder`

**Files:**

- Create: `packages/gateway/src/egress/embedding-egress.ts`
- Create: `packages/gateway/src/egress/embedding-egress.test.ts`

**Interfaces:**

- Consumes: `Embedder.isLocal` (Task 1); `appendEgressEntry(db, entry)` from `egress/egress-ledger.ts`; `EgressAppendFailedError` from `egress/model-egress.ts`.
- Produces: `wrapLedgeredEmbedder(db: Database, embedder: Embedder, now?: () => number): Embedder`.

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/src/egress/embedding-egress.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Embedder } from "../embedding/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { wrapLedgeredEmbedder } from "./embedding-egress.ts";
import { listEgress } from "./egress-verify.ts";

function fake(isLocal: boolean, calls: { n: number }): Embedder {
  return {
    model: isLocal ? "local:minilm" : "openai:text-embedding-3-small",
    dims: 384,
    isLocal,
    embed: async (texts: string[]) => {
      calls.n += 1;
      return texts.map(() => new Float32Array(384));
    },
  };
}

describe("wrapLedgeredEmbedder", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  test("a LOCAL embedder is returned UNCHANGED and appends nothing", async () => {
    // Identity, not a pass-through wrapper -- the same choice `wrapLedgeredProvider` makes.
    // A local embed makes no outbound request, so ledgering it would over-claim egress.
    const calls = { n: 0 };
    const inner = fake(true, calls);
    const wrapped = wrapLedgeredEmbedder(db, inner);
    expect(wrapped).toBe(inner);
    await wrapped.embed(["hello"]);
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a REMOTE embedder appends exactly ONE row per batch", async () => {
    // Per BATCH, not per text: one HTTP request carries the whole array, and a row per text
    // would over-report outbound requests by the batch size.
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls), () => 1_700_000_000_000);
    await wrapped.embed(["a", "b", "c"]);

    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sourceType).toBe("model");
    expect(rows[0]?.destination).toBe("openai");
    expect(rows[0]?.method).toBe("embedding.embed");
    expect(rows[0]?.timestamp).toBe(1_700_000_000_000);
  });

  test("an EMPTY batch appends nothing -- no request is made", async () => {
    // `createOpenAIEmbedder` returns early on an empty array without calling fetch, so a row
    // here would record an outbound request that never happened.
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls));
    await wrapped.embed([]);
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("fail-closed: an append failure aborts, and the delegate never runs", async () => {
    const calls = { n: 0 };
    const wrapped = wrapLedgeredEmbedder(db, fake(false, calls));
    db.close(); // make the append throw
    await expect(wrapped.embed(["x"])).rejects.toThrow();
    expect(calls.n).toBe(0);
    db = new Database(":memory:"); // so afterEach can close something
  });

  test("model and dims proxy faithfully", async () => {
    const wrapped = wrapLedgeredEmbedder(db, fake(false, { n: 0 }));
    expect(wrapped.model).toBe("openai:text-embedding-3-small");
    expect(wrapped.dims).toBe(384);
    expect(wrapped.isLocal).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
bun test packages/gateway/src/egress/embedding-egress.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the wrapper**

Create `packages/gateway/src/egress/embedding-egress.ts`:

```ts
import type { Database } from "bun:sqlite";

import type { Embedder } from "../embedding/types.ts";
import { appendEgressEntry } from "./egress-ledger.ts";
import { redactEgressSummary } from "./egress-record.ts";
import { EgressAppendFailedError } from "./model-egress.ts";

/**
 * The I29 `model`-class appender for EMBEDDINGS -- the last exclusion that class carried.
 *
 * Until this landed, `PROSE_HEAVY_TYPES` routed prose to OpenAI's 1536-dim table with no
 * appender, so `nimbus prove` could report `model: 0` over a window in which vectors really had
 * left the machine. The zero was true about generates and silent about embeddings.
 *
 * A DECORATOR at construction, not a call-site append, for the same reason as
 * `wrapLedgeredProvider`: there are three construction sites
 * (`create-routing-runtime.ts`, `create-embedding-runtime.ts`, `ipc/index-reembed-rpc.ts`) and
 * an unknown number of `embed()` callers. Wrapping the instance covers every caller, including
 * ones written later, without any of them cooperating.
 *
 * Locality is DERIVED from `embedder.isLocal`, never passed in. A local embedder is returned
 * UNCHANGED -- not even a blocked row -- mirroring `LOCAL_ONLY_SYNC_SERVICES` and
 * `wrapLedgeredProvider`. A caller-computed boolean is one wiring mistake away from a
 * fabricated row for a local embed, or a missing one for a remote embed.
 */
export function wrapLedgeredEmbedder(
  db: Database,
  embedder: Embedder,
  now: () => number = Date.now,
): Embedder {
  if (embedder.isLocal) {
    return embedder;
  }
  // `openai:text-embedding-3-small` -> `openai`. The vendor, matching what a `model` row's
  // `destination` means elsewhere: a place data can go, never a raw URL.
  const destination = embedder.model.split(":")[0] ?? embedder.model;

  return {
    model: embedder.model,
    dims: embedder.dims,
    isLocal: embedder.isLocal,
    embed: async (texts: string[]): Promise<Float32Array[]> => {
      // An empty batch makes no request -- `createOpenAIEmbedder` returns early -- so a row
      // would record egress that did not happen.
      if (texts.length === 0) {
        return [];
      }
      try {
        appendEgressEntry(db, {
          timestamp: now(),
          sourceType: "model",
          sourceId: embedder.model,
          destination,
          method: "embedding.embed",
          // `payloadSummary` is REQUIRED on `EgressEntry` and is a debugging aid, never the
          // security boundary -- it is `redactEgressSummary`-scrubbed and capped at 256 bytes.
          // Record the batch SIZE, never the texts: the whole point of the ledger is to prove
          // what left, not to keep a second copy of it.
          payloadSummary: redactEgressSummary({ model: embedder.model, batch: texts.length }),
          hitlStatus: "not_required",
          resultStatus: "authorized",
        });
      } catch (err) {
        throw new EgressAppendFailedError(err);
      }
      return embedder.embed(texts);
    },
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
bun test packages/gateway/src/egress/embedding-egress.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Red-prove the locality derivation**

Temporarily change `if (embedder.isLocal)` to `if (false)`. Run again — the *"a LOCAL embedder is returned UNCHANGED"* test must FAIL. Restore.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/egress/embedding-egress.ts packages/gateway/src/egress/embedding-egress.test.ts
git commit -m "feat(egress): add wrapLedgeredEmbedder, the model-class appender for embeddings"
```

---

### Task 3: Wire it at all three construction sites, and confine it

**Files:**

- Modify: `packages/gateway/src/embedding/create-routing-runtime.ts:48`
- Modify: `packages/gateway/src/embedding/create-embedding-runtime.ts:173`
- Modify: `packages/gateway/src/ipc/index-reembed-rpc.ts:101`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Modify: `packages/gateway/src/security-invariants.test.ts`

**Interfaces:**

- Consumes: `wrapLedgeredEmbedder` (Task 2).

- [ ] **Step 1: Write the static-rule test first**

In `scripts/structure-audit/check-nimbus-invariants.test.ts`, add:

```ts
describe("D22(f) — the embedding appender is confined", () => {
  const file = (relPath: string, contents: string) => [{ relPath, contents }];

  test("flags wrapLedgeredEmbedder called outside the allowed sites", () => {
    const v = checkEmbeddingAppenderConfinement(
      file("packages/gateway/src/agents/rogue.ts", "wrapLedgeredEmbedder(db, e);\n"),
    );
    expect(v.map((x) => x.rule)).toEqual(["embedding-appender-confined"]);
  });

  test("the three construction sites and the definition are allowed", () => {
    const allowed = [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
      "packages/gateway/src/egress/embedding-egress.ts",
    ];
    for (const relPath of allowed) {
      expect(checkEmbeddingAppenderConfinement(file(relPath, "wrapLedgeredEmbedder(db, e);\n"))).toEqual([]);
    }
  });

  test("a call SPLIT ACROSS LINES is still flagged", () => {
    // The D25 lesson: a per-line scan matches neither line of `wrapLedgeredEmbedder\n  (db, e)`.
    const v = checkEmbeddingAppenderConfinement(
      file("packages/gateway/src/agents/rogue.ts", "const x = wrapLedgeredEmbedder\n  (db, e);\n"),
    );
    expect(v).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D22(f)"
```

Expected: FAIL — `checkEmbeddingAppenderConfinement` is not exported.

- [ ] **Step 3: Implement rule (f)**

In `check-nimbus-invariants.ts`, beside the existing D22 rules. **Write the regex with the Edit tool, not a Python heredoc** — a heredoc turns `\b` into a 0x08 backspace and the rule silently matches nothing:

```ts
// D22 (f): the EMBEDDING appender. `egress/embedding-egress.ts`'s `wrapLedgeredEmbedder` is
// the I29 `model`-class appender for embeddings. A file that constructs a remote embedder
// without it puts an unrecorded egress path in the index pipeline -- the exact false zero
// `nimbus prove` would then report a clean window over.
const D22_EMBED_WRAP_RE = /\bwrapLedgeredEmbedder\b/;
const D22_EMBED_WRAP_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/embedding-egress.ts",
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  "packages/gateway/src/ipc/index-reembed-rpc.ts",
];

export function checkEmbeddingAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D22_EMBED_WRAP_ALLOWED.includes(f.relPath)) continue;
    // Whole-source scan, not per-line: `stripComments` preserves length, so a match offset
    // maps 1:1 onto the original line numbering.
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const re = new RegExp(D22_EMBED_WRAP_RE.source, "g");
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "embedding-appender-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}
```

Wire it into `main()` beside the other D22 reporting, with an `::error` message naming the rule.

- [ ] **Step 4: Wrap at the three sites**

`create-routing-runtime.ts` around line 48:

```ts
    openaiEmbedder = wrapLedgeredEmbedder(
      db,
      await createOpenAIEmbedder({
        // ...existing options unchanged
      }),
    );
```

Do the same at `create-embedding-runtime.ts:173` and `ipc/index-reembed-rpc.ts:101`. **All three sites have a `Database` in scope — verified, not assumed:** `tryCreateRoutingEmbeddingRuntime` and `createEmbeddingRuntime` both hold one (the latter already passes it to `tryCreateOpenAIEmbeddingRuntime`), and `resolveEmbedder` has `ctx.db`. No threading is required. If that ever stops being true, thread a handle from the caller rather than making the parameter optional — **an optional db is how `LlmRegistryOptions.db` became a runtime refusal instead of a compile error** (#1356).

- [ ] **Step 5: Add the I29 enforcement test**

In `packages/gateway/src/security-invariants.test.ts`, inside the I29 describe:

```ts
test("I29: every remote-embedder construction site wraps with the appender", async () => {
  // Rule (f) stops a NEW file calling the appender; this stops an EXISTING construction site
  // quietly dropping it. Asserted on source because the sites build real network clients.
  const sites = [
    "packages/gateway/src/embedding/create-routing-runtime.ts",
    "packages/gateway/src/embedding/create-embedding-runtime.ts",
    "packages/gateway/src/ipc/index-reembed-rpc.ts",
  ];
  for (const rel of sites) {
    const src = stripComments(await readFile(resolve(REPO_ROOT, rel), "utf8"));
    expect(src).toContain("createOpenAIEmbedder");
    expect(src).toContain("wrapLedgeredEmbedder");
  }
});
```

Note the `resolve(REPO_ROOT, ...)` — a bare relative path passes locally and ENOENTs in the coverage step, which runs from a different cwd.

- [ ] **Step 6: Verify and red-prove**

```bash
bun run audit:invariants
bun test packages/gateway/src/security-invariants.test.ts scripts/structure-audit
```

Then remove `wrapLedgeredEmbedder` from `create-routing-runtime.ts` and confirm the I29 test FAILS. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/embedding packages/gateway/src/ipc/index-reembed-rpc.ts scripts/structure-audit packages/gateway/src/security-invariants.test.ts
git commit -m "feat(egress): ledger every remote embedding batch (I29 D22(f))"
```

---

### Task 4: Correct the I29 claim everywhere it is stated

**Files:**

- Modify: `packages/gateway/src/egress/egress-coverage.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`
- Modify: `.claude/commands/nimbus-egress.md`

- [ ] **Step 1: Find every statement of the claim**

```bash
git grep -n "ONE EXCLUSION REMAINS\|remaining exclusion is EMBEDDINGS\|embeddings still append nothing\|PROSE_HEAVY_TYPES routes to OpenAI"
```

**A total that is still right can hide an enumeration that is wrong** — re-derive the list, do not trust the count. Expect hits in `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md` and `.claude/commands/nimbus-egress.md`.

- [ ] **Step 2: Rewrite each to say the class is now closed**

The `model` class now covers route-table generates, the Mastra agent, the `ask` classifier **and** embeddings. State plainly what a zero now means, and keep any bound that survives — for example a local embedder still appends nothing, which is correct and not an exclusion.

- [ ] **Step 3: Verify the docs gates**

```bash
bun run audit:doc-refs && bun run audit:status-drift && bun run lint:markdown
```

Watch for MD049: emphasis style in `docs/CHANGELOG.md` is inferred from the FIRST emphasis in the file, so an `_underscore_` added near the top turns every later `*asterisk*` into an error.

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## Post-Phase-6 deliveries` in `docs/CHANGELOG.md`, dated, saying what a `model: 0` now covers and that a local embedder still appends nothing by construction.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md GEMINI.md docs .claude packages/gateway/src/egress/egress-coverage.ts
git commit -m "docs(egress): the model class no longer excludes embeddings"
```

- [ ] **Step 6: Ship Part A**

Open a PR titled `feat(egress): ledger remote embeddings, closing I29's last model-class exclusion`. **No `!`** — nothing a user must change.

Before pushing: `bun run preflight:fast`, then `bun test packages/gateway packages/cli scripts`, then the Linux coverage floor via the docker block in `scripts/coverage-floor/reseed-docker.sh` (with `--update-baseline` REMOVED) followed by `bun run audit:coverage-floor`.

---

## Part B — Per-Task Model Routing

> Depends on nothing in Part A; ships as its own PR. Do Part A first only because it closes an honesty gap that every later row builds on.

### Task 5: Parse `[llm.tasks]`

**Files:**

- Modify: `packages/gateway/src/config/nimbus-toml.ts`
- Modify: `packages/gateway/src/config/nimbus-toml-llm.test.ts`

**Interfaces:**

- Produces: `NimbusLlmToml.taskPins?: ReadonlyMap<LlmTaskType, string>` — task type → route id.

- [ ] **Step 1: Write the failing tests**

```ts
test("parses [llm.tasks] into a task -> routeId map", () => {
  const src = `[llm.tasks]\nclassification = "ollama/llama3.2:latest"\nreasoning = "ollama/qwen3:14b"\n`;
  const cfg = parseNimbusTomlLlmSection(src);
  expect(cfg.taskPins?.get("classification")).toBe("ollama/llama3.2:latest");
  expect(cfg.taskPins?.get("reasoning")).toBe("ollama/qwen3:14b");
});

test("an UNKNOWN task type is dropped, and the rest of the table survives", () => {
  // Same posture as route_priority: a bad entry must never revert the whole section, because
  // `loadTomlSection`'s bare catch would take `enforce_air_gap` down with it.
  const src = `[llm.tasks]\nteleportation = "ollama/x"\nreasoning = "ollama/qwen3:14b"\n`;
  const cfg = parseNimbusTomlLlmSection(src);
  expect(cfg.taskPins?.has("teleportation" as never)).toBe(false);
  expect(cfg.taskPins?.get("reasoning")).toBe("ollama/qwen3:14b");
});

test("absent [llm.tasks] leaves taskPins undefined, not an empty map", () => {
  expect(parseNimbusTomlLlmSection(`[llm]\nprefer_local = true\n`).taskPins).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch fail.** `bun test packages/gateway/src/config/nimbus-toml-llm.test.ts`

- [ ] **Step 3: Implement** — a `[llm.tasks]` table handler alongside the existing `[llm.local.*]` / `[llm.remote.*]` prefixes, keyed on the four `LlmTaskType` values (`classification`, `reasoning`, `summarisation`, `agent_step`), dropping unknown keys.

- [ ] **Step 4: Run tests.** Expected PASS.

- [ ] **Step 5: Commit** — `feat(config): parse [llm.tasks] per-task route pins`

---

### Task 6: The router honours a pin

**Files:**

- Modify: `packages/gateway/src/llm/router.ts`
- Modify: `packages/gateway/src/llm/router.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`

**Interfaces:**

- Consumes: `NimbusLlmToml.taskPins` (Task 5).
- Produces: `LlmRouterConfig.taskPins?: ReadonlyMap<LlmTaskType, string>`.

- [ ] **Step 1: Write the failing tests**

```ts
test("a pinned task uses its route even when preferLocal would order differently", async () => {
  const router = new LlmRouter({
    ...DEFAULT_CONFIG,
    preferLocal: true,
    taskPins: new Map([["classification", "ollama/small"]]),
  });
  router.registerRoute(makeFakeProvider("ollama", true), "big");
  router.registerRoute(makeFakeProvider("ollama", true), "small");
  const route = await router.selectRoute("classification");
  expect(route?.routeId).toBe("ollama/small");
});

test("a pin that names an UNREGISTERED route falls back to normal ordering", async () => {
  // Fail-OPEN here, deliberately, and this is the one place in the egress work where that is
  // right: a stale pin must degrade to a working answer, not an outage. The pin selects among
  // routes that are already registered and already ledgered -- it cannot widen egress.
  const router = new LlmRouter({
    ...DEFAULT_CONFIG,
    taskPins: new Map([["classification", "ollama/gone"]]),
  });
  router.registerRoute(makeFakeProvider("ollama", true), "big");
  expect((await router.selectRoute("classification"))?.routeId).toBe("ollama/big");
});

test("a pinned route that is UNAVAILABLE falls through to the next eligible route", async () => {
  const router = new LlmRouter({
    ...DEFAULT_CONFIG,
    taskPins: new Map([["reasoning", "ollama/down"]]),
  });
    // `makeFakeProvider(id, available)` -- two args; the fake derives `isLocal` from `id`.
  router.registerRoute(makeFakeProvider("ollama", false), "down");
  router.registerRoute(makeFakeProvider("ollama", true), "up");
  expect((await router.selectRoute("reasoning"))?.routeId).toBe("ollama/up");
});

test("a pin does NOT override air-gap", async () => {
  // enforce_air_gap is a refusal, not a preference. A pin naming a remote route under air-gap
  // must not resurrect it.
  const router = new LlmRouter({
    ...DEFAULT_CONFIG,
    enforceAirGap: true,
    taskPins: new Map([["reasoning", "anthropic/claude-x"]]),
  });
  router.registerRoute(makeFakeProvider("anthropic", false), "claude-x");
  expect(await router.selectRoute("reasoning")).toBeUndefined();
});
```

- [ ] **Step 2: Run and watch fail.**

- [ ] **Step 3: Implement** — seed a private mutable `Map<LlmTaskType, string>` from `config.taskPins` in the constructor (`config` is `private readonly` and `taskPins` is a `ReadonlyMap`, so Task 7's `setTaskPin` needs a mutable copy to write). In `orderedRoutes`, when THAT map names a route id for this task and the id resolves to a registered route, move it to the FRONT of the ordering. Do not bypass `eligibleRoutes`' air-gap and capability-floor filters: the pin reorders candidates, it never exempts one. Thread `taskPins` through `assemble.ts` into `LlmRouterConfig`.

- [ ] **Step 4: Run tests.** Also run `bun test packages/gateway/src/llm` to confirm no existing routing test regressed.

- [ ] **Step 5: Commit** — `feat(llm): honour [llm.tasks] route pins in the router`

---

### Task 7: `nimbus llm use` — writing the SAME TOML table

**Files:**

- Modify: `packages/gateway/src/ipc/llm-rpc.ts`
- Modify: `packages/cli/src/commands/llm.ts`
- Modify: `packages/cli/src/commands/llm.test.ts`
- Modify: `packages/gateway/src/ipc/llm-rpc.test.ts`
- Modify: `docs/cli-reference.md`

**Interfaces:**

- Consumes: `LlmRouterConfig.taskPins` (Task 6); `setTomlValueInFile` (already used by `nimbus config set`).
- Produces: IPC method `llm.use({ task, routeId })`.

> **Design note — one store, not two.** `llm.use` writes `[llm.tasks].<task>` into `nimbus.toml`, the same table Task 5 parses and Task 6 reads. It does **not** write `llm_task_defaults`. See Review Response 1 for why a second store was rejected.

- [ ] **Step 1: Write the failing IPC tests**

> `makeLlmRpcFixture` and `dispatch` below are SHAPE, not existing helpers — `llm-rpc.test.ts` has neither. Use whatever harness that file already uses to build a registry and invoke a method, and keep the assertions as written.

```ts
test("llm.use writes the pin into [llm.tasks] and updates the live router", async () => {
  const { registry, tomlPath } = makeLlmRpcFixture();
  registry.addRoute(makeProvider("ollama", true), "llama3.2:latest");

  await dispatch("llm.use", { task: "classification", routeId: "ollama/llama3.2:latest" });

  // Persisted: survives a restart, because boot re-reads exactly this table.
  expect(readFileSync(tomlPath, "utf8")).toContain('classification = "ollama/llama3.2:latest"');
  // AND live: the running router honours it without a restart.
  expect((await registry.llmRouter.selectRoute("classification"))?.routeId).toBe("ollama/llama3.2:latest");
});

test("llm.use REFUSES a route id that is not registered, and writes nothing", async () => {
  // Fail-closed on the WRITE path, deliberately unlike the router's fail-open on a stale pin
  // (Task 6). Writing an unresolvable id would persist a pin that silently never applies --
  // which is the orphaned-config shape this plan exists to stop repeating.
  const { tomlPath } = makeLlmRpcFixture();
  const before = readFileSync(tomlPath, "utf8");

  await expect(dispatch("llm.use", { task: "reasoning", routeId: "ollama/ghost" })).rejects.toThrow(
    /not a registered route/,
  );
  expect(readFileSync(tomlPath, "utf8")).toBe(before);
});

test("llm.use REFUSES an unknown task type", async () => {
  await expect(dispatch("llm.use", { task: "teleportation", routeId: "ollama/x" })).rejects.toThrow(
    /classification|reasoning|summarisation|agent_step/,
  );
});
```

- [ ] **Step 2: Run and watch them fail**

```bash
bun test packages/gateway/src/ipc/llm-rpc.test.ts -t "llm.use"
```

Expected: FAIL — method not registered.

- [ ] **Step 3: Implement `llm.use`**

In `ipc/llm-rpc.ts`:

```ts
// Validated against REGISTERED routes, then written to nimbus.toml and applied live.
//
// Gateway-side rather than CLI-side because the gateway is what owns nimbus.toml and what knows
// which routes exist. Splitting it -- CLI validates over IPC, then writes the file itself --
// would put the check and the write in different processes with a window between them.
async function handleLlmUse(params: unknown): Promise<{ ok: true }> {
  const p = asRecord(params);
  const task = stringField(p, "task");
  const routeId = stringField(p, "routeId");
  if (task === undefined || !LLM_TASK_TYPES.includes(task as LlmTaskType)) {
    throw new Error(`Unknown task type "${String(task)}". Expected one of: ${LLM_TASK_TYPES.join(", ")}.`);
  }
  if (routeId === undefined || registry.llmRouter.routeFor(routeId) === undefined) {
    const known = registry.llmRouter.routes().map((r) => r.routeId).join(", ");
    throw new Error(`"${String(routeId)}" is not a registered route. Registered: ${known}`);
  }
  setTomlValueInFile(activeTomlPath, `llm.tasks.${task}`, routeId);
  registry.llmRouter.setTaskPin(task as LlmTaskType, routeId);
  return { ok: true };
}
```

Add `setTaskPin(task, routeId)` to `LlmRouter`. **It cannot mutate `config.taskPins`** — `config` is `private readonly` and `taskPins` is a `ReadonlyMap`. Task 6 therefore seeds a private mutable `Map<LlmTaskType, string>` from `config.taskPins` at construction, `orderedRoutes` reads THAT map, and `setTaskPin` mutates it. The config object stays immutable; only the router's own copy moves.

- [ ] **Step 4: Add the CLI subcommand**

```ts
if (subcommand === "use") {
  const [task, routeId] = rest;
  if (task === undefined || routeId === undefined) {
    throw new Error("Usage: nimbus llm use <task> <routeId>   (see `nimbus llm status` for route ids)");
  }
  await withGatewayIpc((c) => runLlmUseImpl(c, { task, routeId }));
  return;
}
```

Extend the `help` block:

```bash
  use <task> <routeId>   Pin a task type to a registered route
```

- [ ] **Step 5: Confirm the exposure surfaces**

`llm.use` is a MUTATION. Check `nimbus-tauri-allowlist` (I7) and `nimbus-http-write-surface` (I13): it must **not** appear in the Tauri `ALLOWED_METHODS` or the HTTP `WRITE_ROUTE_ALLOWLIST` unless deliberately intended. Add a test asserting its absence from both, so a later bulk edit cannot add it silently.

- [ ] **Step 6: Run the tests**

```bash
bun test packages/gateway/src/ipc/llm-rpc.test.ts packages/cli/src/commands/llm.test.ts
```

- [ ] **Step 7: Document**

In `docs/cli-reference.md`, beside `nimbus llm status`: both forms write the **same** `[llm.tasks]` table — the CLI is a validated shortcut for editing it by hand, and takes effect immediately as well as persisting.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/llm-rpc.ts packages/gateway/src/llm/router.ts packages/cli/src/commands/llm.ts docs/cli-reference.md
git commit -m "feat(llm): add nimbus llm use to pin a task to a route"
```

---

### Task 8: Retire the dead `setDefault` / `getDefault`

**Files:**

- Modify: `packages/gateway/src/llm/registry.ts`
- Modify: `packages/gateway/src/llm/registry.test.ts`

> Do this LAST, after Task 7 proves the TOML path works. Deleting first would remove the only existing per-task storage before its replacement is demonstrated.

- [ ] **Step 1: Confirm they are still unused**

```bash
git grep -n "setDefault\|getDefault" -- packages | grep -v "\.test\."
```

Expected: only the definitions in `registry.ts`. If Task 7 was implemented correctly, nothing else references them.

- [ ] **Step 2: Delete both methods and their two tests**

Remove `setDefault`, `getDefault`, and the `LlmRegistry.setDefault / getDefault` describe block.

- [ ] **Step 3: Leave the V20 table, and say why**

Add above the class:

```ts
// `llm_task_defaults` (V20) is intentionally left in the schema and intentionally unused. Its
// `setDefault`/`getDefault` accessors were deleted on 2026-08-29: nothing had ever read them, and
// per-task pinning now lives in `[llm.tasks]` in nimbus.toml -- ONE store, so there is no
// precedence question between a file and a table. Dropping the table would need a migration and
// buy nothing; an empty table costs nothing. Do not wire it back up without deciding which source
// wins, because two sources for one setting is what made the accessors dead in the first place.
```

- [ ] **Step 4: Note the latent bug that dies with the code**

In the commit body, record what was deleted: `getDefault` compared `row === undefined` while `bun:sqlite`'s `.get()` returns **`null`** for no matching row, so a lookup for an unpinned task threw `TypeError: null is not an object` instead of returning `undefined`. Verified against `bun:sqlite` directly. No test covered it — both existing tests were happy-path — so it was latent, not deliberately encoded.

- [ ] **Step 5: Verify**

```bash
bun run typecheck && bun test packages/gateway/src/llm
```

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/llm
git commit -m "refactor(llm): delete the dead setDefault/getDefault accessors"
```

---

## Review Responses

Cross-model review: `2026-08-29-embedding-egress-and-task-routing-review.md`. Three findings, all
legitimate. Two fixed; one fixed differently from the suggestion, for a reason worth recording.

### 1. DB-persisted defaults are never loaded at boot — FIXED, but not by merging

**The finding is correct and it was the plan's worst defect.** `nimbus llm use` would have written
`llm_task_defaults` via `setDefault`, while boot built `taskPins` from `nimbus.toml` alone. The
command would have appeared to work and changed nothing — the exact orphaned-plumbing shape this
plan was partly written to stop repeating (`classifier_model`, `remote_model`, and `getDefault`
itself are three instances found in the last two days).

**The suggested fix was to load the table at boot and merge, with a precedence rule.** Rejected,
and the review's own "Open Question" is why: needing to ask *which wins, the file or the table?*
is the signal that the design has two sources of truth for one setting. Whichever answer is
picked, a user will one day set a pin one way and watch the other silently win.

**Instead there is one store.** `llm.use` writes `[llm.tasks]` in `nimbus.toml` — the same table
Task 5 parses and Task 6 reads — and also applies the pin to the live router so it takes effect
without a restart. No boot merge, no precedence rule, no second store to drift.

This follows existing repo precedent rather than inventing one: `nimbus connector set-interval`
writes the index and there is deliberately **no** TOML key for sync cadence, exactly so the
question cannot arise. `docs/cli-reference.md` says so outright.

The cost, stated plainly: `llm.use` now writes the user's config file. That is a heavier action
than writing a table, so Task 7 refuses to write an unregistered route id at all — fail-closed on
the write path, deliberately unlike the router's fail-open on a stale pin at read time.

### 2. `getDefault` returns `null`, not `undefined` — CONFIRMED, and deleted rather than patched

**Verified directly against `bun:sqlite`** rather than taken on trust:

```bash
no-row .get() => null   ===null: true   ===undefined: false
ternary `row === undefined ? undefined : row.provider`  =>  THROW: null is not an object
```

So a lookup for an unpinned task throws `TypeError` instead of returning `undefined`. Real bug.

**One detail in the finding is wrong, and it changes the remedy.** The review says *"The test in
`registry.test.ts` asserts this throwing behavior."* It does not. There are two `getDefault` tests
and both are happy-path — a row is written, then read back. **No test covers the missing-row case
at all.** The bug is latent and uncovered, not deliberately encoded, so nothing needs updating to
expect `undefined`; a test would have needed *adding*.

Which makes the remedy simpler than the suggested patch. Under Response 1 these accessors have no
caller and never will, so **Task 8 deletes them** instead of fixing dead code — consistent with
the same day's removal of `classifier_model` and `remote_model`. The V20 table stays (dropping it
needs a migration and buys nothing) with a comment saying it is deliberately unused and why wiring
it back up would reintroduce the precedence problem.

### 3. Construction sites already have a `Database` — ACCEPTED, risk closed

The plan flagged this as unverified and asked the executor to check. The review checked all three:
`tryCreateRoutingEmbeddingRuntime`, `createEmbeddingRuntime` (which already passes its handle to
`tryCreateOpenAIEmbeddingRuntime`), and `resolveEmbedder` via `ctx.db`. No threading needed.

Task 3 and the Self-Review now state this as verified. The instruction to thread rather than make
the parameter optional stays, as guidance if that ever stops holding — an optional db is precisely
how `LlmRegistryOptions.db` became a runtime refusal instead of a compile error (#1356).

### Net effect on scope

One task added (Task 8), Task 7 rewritten, no task removed. Both parts remain non-breaking:
deleting `setDefault`/`getDefault` touches `LlmRegistry`, internal to a `private: true` package
with no published surface — `refactor(llm):`, **not** `refactor(llm)!:`.

---

## Self-Review

**Spec coverage.** The roadmap's *Still open* clause names four items. Two are covered: `[llm.tasks]` per-task pinning (Tasks 5–6) with `nimbus llm use` writing that same table (Task 7), and the embeddings appender (Tasks 1–4). Task 8 is not from the roadmap — it is the cross-model review's second finding, folded in. **Two are deliberately NOT in this plan** — Bedrock/SigV4 (slice 3) and a local OpenAI-compatible runtime — because each is a new provider adapter with its own credential path, and bundling them would produce a PR too large to review against the invariant checklist.

**Placeholder scan.** No TBDs. Every code step carries real code; every test step carries real assertions.

**Type consistency.** `Embedder.isLocal` (Task 1) is read by `wrapLedgeredEmbedder` (Task 2) and asserted in Task 3. `taskPins` is `ReadonlyMap<LlmTaskType, string>` in Tasks 5, 6 and 7 alike. Task 8 deleted `getDefault` only — it was dead code, never called — and kept `setDefault`'s existing V20 signature unchanged: `llm.setDefault` is a live, renderer-exposed IPC method the desktop UI calls, so deleting it would have been a breaking change.

**The one open risk is now closed.** Task 3 needs a `Database` at all three construction sites; the cross-model review verified all three have one (`tryCreateRoutingEmbeddingRuntime`, `createEmbeddingRuntime`, and `resolveEmbedder`'s `ctx.db`). No threading is required, and the plan no longer carries an unverified assumption into execution.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-29-embedding-egress-and-task-routing.md`.
