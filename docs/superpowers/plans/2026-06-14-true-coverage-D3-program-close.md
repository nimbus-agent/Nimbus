# True Coverage D3 — Program Close Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the True Coverage program: relocate test-helpers so their exemption is self-enforcing, delete/correct stale exclusions, group + guard the type-only entries, extract `EmbeddingWorkerCore` (the one real refactor) and resolve the §5.3 worker probe, document the genuinely-untestable bucket, and close the program out (CHANGELOG + memory).

**Architecture:** Single finale PR off `origin/main` 209fc966 (worktree `.claude/worktrees/tc-D3`, branch `dev/asafgolombek/true-coverage-D3`). Most work is relocation/documentation (zero coverage impact). The only coverage-touching unit is the new `embedding-worker-core.ts` (DI-seamed, driven ≥80% line+branch **and** ≥80% Sonar `new_coverage`); the residual `embedding-worker.ts` stays an excluded thin wiring shell. Reseed the committed baseline from the PR's own merge-commit lcov; `files` must stay `{}`.

**Tech Stack:** Bun 1.3.x + TypeScript strict, `bun:test`, `bun:sqlite` (real in-memory DBs), Biome, istanbul-under-bun coverage (`scripts/coverage-floor/`), Docker `oven/bun:latest` for the Linux-authoritative reseed.

**Spec:** [`docs/superpowers/specs/2026-06-14-true-coverage-D3-program-close-design.md`](../specs/2026-06-14-true-coverage-D3-program-close-design.md) (+ `-review.md` dispositions).

**Non-negotiables for every task:** No `any` (use `unknown`). No `mock.module` (DI only — it leaks in the combined cli run). No `biome-ignore` / `istanbul-ignore`. Validate biome via `bunx biome check <files>` (not `bun run lint`, which false-fails under `.claude/`). Run `bun run lint:markdown` from inside the worktree and read its output for any doc change. No absolute `file:///C:/...` links in docs.

---

## File Structure

**Relocated (git mv, history preserved):**

- `packages/cli/src/tui/test-helpers/context.ts` → `packages/cli/src/tui/testing/context.ts`
- `packages/cli/src/commands/cli-test-helpers.ts` → `packages/cli/src/commands/testing/cli-test-helpers.ts`
- `packages/gateway/src/identity/identity-test-helpers.ts` → `packages/gateway/src/identity/testing/identity-test-helpers.ts`
- `packages/gateway/src/updater/updater-test-fixtures.ts` → `packages/gateway/src/updater/testing/updater-test-fixtures.ts`

**Created:**

- `packages/gateway/src/embedding/embedding-worker-core.ts` — the extracted, DI-seamed worker orchestration (NEW covered source).
- `packages/gateway/src/embedding/embedding-worker-core.test.ts` — its unit tests.

**Modified:**

- `scripts/coverage-floor/exclusions.ts` — drop 4 relocated entries + the redundant `sandbox-probe.ts` entry; correct the `chatops-tool-runner-e2e-sink.ts` comment; group the 11 type-only entries; full category-comment pass.
- `packages/gateway/src/embedding/embedding-worker.ts` — reduce to a thin wiring shell delegating to `EmbeddingWorkerCore` (stays excluded).
- 12 test importers (exact lines in Task 1).
- 11 type-only source files — 3-line guardian header each (zero `SF:` impact).
- `docs/CHANGELOG.md`, the workstream memory, `MEMORY.md`.

---

## Task 1: Relocate the 4 test-helpers under `testing/` (self-enforcing exemption)

`scripts/coverage-floor/check.ts:160` already auto-skips any `/testing/` path, so a relocated helper needs no explicit exclusion. Do all 4 in one task (pure mechanical moves, no coverage change), commit once.

**Files:**

- Move (git mv): the 4 files in the File Structure section.
- Modify importers (exact current → new):
  - `packages/cli/src/tui/App.test.tsx:6` `from "./test-helpers/context.ts"` → `from "./testing/context.ts"`
  - `packages/cli/src/tui/ipc-context.test.tsx:7` `from "./test-helpers/context.ts"` → `from "./testing/context.ts"`
  - `packages/cli/src/commands/identity.test.ts:5` `from "./cli-test-helpers.ts"` → `from "./testing/cli-test-helpers.ts"`
  - `packages/cli/src/commands/scim.test.ts:2` `from "./cli-test-helpers.ts"` → `from "./testing/cli-test-helpers.ts"`
  - `packages/gateway/src/identity/identity-boot.test.ts:10` `from "./identity-test-helpers.ts"` → `from "./testing/identity-test-helpers.ts"`
  - `packages/gateway/src/identity/identity-runtime.test.ts:8` same rename
  - `packages/gateway/src/identity/identity-vault.test.ts:3` same rename
  - `packages/gateway/src/identity/teams-bot-jwt.test.ts:4` same rename
  - `packages/gateway/src/identity/verifier.test.ts:6` same rename
  - `packages/gateway/src/ipc/updater-rpc.test.ts:4` `from "../updater/updater-test-fixtures.ts"` → `from "../updater/testing/updater-test-fixtures.ts"`
  - `packages/gateway/src/updater/manifest-fetcher.test.ts:4` `from "./updater-test-fixtures.ts"` → `from "./testing/updater-test-fixtures.ts"`
  - `packages/gateway/src/updater/updater.test.ts:12` (multiline import; the `from` line) `from "./updater-test-fixtures.ts"` → `from "./testing/updater-test-fixtures.ts"`
  - `packages/gateway/test/integration/updater/air-gap.test.ts:5` `from "../../../src/updater/updater-test-fixtures.ts"` → `from "../../../src/updater/testing/updater-test-fixtures.ts"`
- Modify: `scripts/coverage-floor/exclusions.ts` — delete the 4 exact entries (`tui/test-helpers/context.ts`, `commands/cli-test-helpers.ts`, `identity/identity-test-helpers.ts`, `updater/updater-test-fixtures.ts`) and their shared "Test-only support files" comment block (lines ~78–84).

- [ ] **Step 1: git mv the 4 files**

```bash
cd packages/cli/src/tui && mkdir -p testing && git mv test-helpers/context.ts testing/context.ts && rmdir test-helpers 2>/dev/null; cd -
cd packages/cli/src/commands && mkdir -p testing && git mv cli-test-helpers.ts testing/cli-test-helpers.ts; cd -
cd packages/gateway/src/identity && mkdir -p testing && git mv identity-test-helpers.ts testing/identity-test-helpers.ts; cd -
cd packages/gateway/src/updater && mkdir -p testing && git mv updater-test-fixtures.ts testing/updater-test-fixtures.ts; cd -
```

- [ ] **Step 2: Update all 13 importer lines** (use the exact mappings above; edit each file).

- [ ] **Step 3: Remove the 4 exclusion entries** from `scripts/coverage-floor/exclusions.ts` (delete the 4 `{ kind: "exact", path: … }` lines and the preceding `// Test-only support files …` comment block).

- [ ] **Step 4: Typecheck + run the affected suites**

Run:

```bash
bun run --filter '@nimbus-dev/cli' typecheck && bun run --filter '@nimbus-dev/gateway' typecheck
bun test packages/cli/src/tui/App.test.tsx packages/cli/src/tui/ipc-context.test.tsx packages/cli/src/commands/identity.test.ts packages/cli/src/commands/scim.test.ts
bun test packages/gateway/src/identity/ packages/gateway/src/updater/ packages/gateway/src/ipc/updater-rpc.test.ts
```

Expected: typecheck clean; all suites PASS (imports resolve from the new `testing/` paths).

- [ ] **Step 5: Verify the relocated files are auto-skipped**

Run:

```bash
bun -e "import {isExempt} from './scripts/coverage-floor/exclusions.ts'; for (const p of ['packages/cli/src/tui/testing/context.ts','packages/cli/src/commands/testing/cli-test-helpers.ts','packages/gateway/src/identity/testing/identity-test-helpers.ts','packages/gateway/src/updater/testing/updater-test-fixtures.ts']) console.log(p, isExempt(p));"
```

Expected: `isExempt` returns `false` for all four (they are no longer in EXCLUSIONS) — confirm `discoverSourceFiles` skips them instead. Then:

```bash
bun -e "import {discoverSourceFiles} from './scripts/coverage-floor/check.ts'" 2>/dev/null || true
```

The authoritative check is the `/testing/` skip in `check.ts:160` — confirm by reading that the relocated paths contain `/testing/`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "refactor(coverage): relocate 4 test-helpers under testing/ (self-enforcing exemption)

Drops their explicit exclusions; discoverSourceFiles auto-skips /testing/."
```

---

## Task 2: Delete the redundant `sandbox-probe.ts` exclusion entry

`packages/sdk/src/testing/sandbox-probe.ts` is already under a `testing/` dir → already auto-skipped → its exact exclusion is dead config.

**Files:** Modify `scripts/coverage-floor/exclusions.ts` (delete line 32: `{ kind: "exact", path: "packages/sdk/src/testing/sandbox-probe.ts" }`).

- [ ] **Step 1: Confirm it is already auto-skipped**

Run:

```bash
grep -n "testing/" scripts/coverage-floor/check.ts | head
```

Expected: the `discoverSourceFiles` filter that skips `/testing/` (≈ line 160) is present; `sdk/src/testing/sandbox-probe.ts` matches it.

- [ ] **Step 2: Delete the exclusion entry** (line 32).

- [ ] **Step 3: Typecheck the exclusions module**

Run: `bun -e "import './scripts/coverage-floor/exclusions.ts'; console.log('ok')"`
Expected: `ok` (no syntax error).

- [ ] **Step 4: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts && git commit -m "chore(coverage): drop redundant sandbox-probe.ts exclusion (already under testing/)"
```

---

## Task 3: Correct the `chatops-tool-runner-e2e-sink.ts` comment

It is production-imported by `platform/assemble.ts:16` — the current "TEST-ONLY … never exercised in a normal gateway boot" comment is false. Keep it excluded; correct the comment; move it into the genuinely-untestable (d) block (done in Task 6's grouping, but fix the comment here).

**Files:** Modify `scripts/coverage-floor/exclusions.ts` (the comment block at lines ~71–76).

- [ ] **Step 1: Replace the comment** above the `chatops-tool-runner-e2e-sink.ts` entry with:

```ts
  // `chatops-tool-runner-e2e-sink.ts` (Phase 6 Slice 5): env-gated by `NIMBUS_CHATOPS_E2E_SINK_DIR`
  // (same precedent class as `NIMBUS_SKIP_EMBEDDING_RUNTIME`) and STATICALLY IMPORTED by production boot
  // (`platform/assemble.ts`) — so it is excluded as a genuinely-untestable env-gated shell, NOT relocated
  // (relocating it would point a production import into the coverage-skipped tree). It is the file-backed
  // mock ChatOps transport that stands in for the bot-credentialed connector subprocess in the e2e; inert
  // in a normal boot (the env var is unset). Imports are production-safe: node:fs/node:path + type-only.
```

- [ ] **Step 2: Verify the production import still exists** (guards against a stale comment in the other direction)

Run: `grep -n "chatops-tool-runner-e2e-sink" packages/gateway/src/platform/assemble.ts`
Expected: one match (the `} from "../chatops/chatops-tool-runner-e2e-sink.ts";` import).

- [ ] **Step 3: Typecheck** the exclusions module (`bun -e "import './scripts/coverage-floor/exclusions.ts'; console.log('ok')"`). Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts && git commit -m "docs(coverage): correct chatops-e2e-sink comment (production-imported, not test-only)"
```

---

## Task 4: Extract `EmbeddingWorkerCore` (TDD) — the one real refactor

Extract the worker's stateful orchestration into an injectable class so it can be unit-tested without the worker realm. The residual `embedding-worker.ts` becomes a thin wiring shell (stays excluded). Write the test FIRST.

**Files:**

- Create: `packages/gateway/src/embedding/embedding-worker-core.ts`
- Test: `packages/gateway/src/embedding/embedding-worker-core.test.ts`
- Modify: `packages/gateway/src/embedding/embedding-worker.ts` (reduce to wiring)

### Seam design

The core accepts injected deps:

- `sendToMain(data: unknown): void` — replaces the module `postMessage` helper.
- `setup(msg: InitMsg): Promise<{ db: EmbeddingWorkerDb; pipeline: EmbeddingWorkerPipeline }>` — the heavy construction (real `setupDb` + `createLocalEmbedder` + `new SqliteEmbeddingPipeline`) stays in the residual shell's injected lambda; tests inject a fake that returns fakes (and can throw to drive the init-error path).

`EmbeddingWorkerDb` / `EmbeddingWorkerPipeline` are minimal **structural** interfaces (the real `bun:sqlite` `Database` and `SqliteEmbeddingPipeline` are assignable — no `any`, no heavy import in the core for the seam).

- [ ] **Step 1: Write the failing test** `packages/gateway/src/embedding/embedding-worker-core.test.ts`

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import {
  EmbeddingWorkerCore,
  type EmbeddingWorkerPipeline,
  type EmbeddingWorkerSetup,
  type InitMsg,
  type InMsg,
} from "./embedding-worker-core.ts";

const INIT: InitMsg = {
  type: "init",
  dbPath: ":memory:",
  cacheDir: "/cache",
  toml: { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 50 },
};

// Track real in-memory DBs so afterEach can close them (B13 graph-populator lesson — no handle leaks).
const openDbs: Database[] = [];
afterEach(() => {
  while (openDbs.length > 0) openDbs.pop()?.close();
});

function newItemDb(rows: { id: string }[] = []): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  db.run(
    "CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT, type TEXT, title TEXT, body_preview TEXT)",
  );
  for (const r of rows) {
    db.run("INSERT INTO item (id, service, type, title, body_preview) VALUES (?,?,?,?,?)", [
      r.id,
      "svc",
      "note",
      "t",
      "b",
    ]);
  }
  return db;
}

function fakePipeline(over: Partial<EmbeddingWorkerPipeline> = {}): EmbeddingWorkerPipeline {
  return {
    embedTexts: async () => [],
    embedItem: async () => {},
    backfillAll: async () => {},
    ...over,
  };
}

function isType(d: unknown, t: string): boolean {
  return typeof d === "object" && d !== null && (d as { type?: unknown }).type === t;
}

/** Drives init and resolves once `backfill_done` is posted (deterministic — no timers). */
async function initReadyCore(setup: EmbeddingWorkerSetup): Promise<{
  core: EmbeddingWorkerCore;
  posted: unknown[];
}> {
  const posted: unknown[] = [];
  let done!: () => void;
  const ready = new Promise<void>((r) => {
    done = r;
  });
  const core = new EmbeddingWorkerCore({
    sendToMain: (d) => {
      posted.push(d);
      if (isType(d, "backfill_done")) done();
    },
    setup,
  });
  core.handleMessage(INIT);
  await ready;
  return { core, posted };
}

describe("EmbeddingWorkerCore", () => {
  it("posts ready, backfill_progress, backfill_done on init success", async () => {
    const pipeline = fakePipeline({
      backfillAll: async (onProgress) => {
        onProgress?.(1, 2);
      },
    });
    const { posted } = await initReadyCore(async () => ({ db: newItemDb(), pipeline }));
    expect(posted).toContainEqual({ type: "ready" });
    expect(posted).toContainEqual({ type: "backfill_progress", done: 1, total: 2 });
    expect(posted).toContainEqual({ type: "backfill_done", success: true });
  });

  it("posts backfill_done success:false when backfill throws (best-effort)", async () => {
    const pipeline = fakePipeline({
      backfillAll: async () => {
        throw new Error("backfill boom");
      },
    });
    const { posted } = await initReadyCore(async () => ({ db: newItemDb(), pipeline }));
    expect(posted).toContainEqual({ type: "ready" });
    expect(posted).toContainEqual({ type: "backfill_done", success: false });
  });

  it("posts init_error and stays not-ready when setup throws", async () => {
    const posted: unknown[] = [];
    let errored!: () => void;
    const gotError = new Promise<void>((r) => {
      errored = r;
    });
    const core = new EmbeddingWorkerCore({
      sendToMain: (d) => {
        posted.push(d);
        if (isType(d, "init_error")) errored();
      },
      setup: async () => {
        throw new Error("setup boom");
      },
    });
    core.handleMessage(INIT);
    await gotError;
    expect(posted).toContainEqual({ type: "init_error", message: "setup boom" });
    // Not ready: a subsequent embed_texts is ignored (no embed_texts_result posted).
    core.handleMessage({ type: "embed_texts", id: "x", texts: ["a"] });
    await Promise.resolve();
    expect(posted.some((p) => isType(p, "embed_texts_result"))).toBe(false);
  });

  it("ignores embed_texts / embed_item before init (not-ready guard)", () => {
    const posted: unknown[] = [];
    const core = new EmbeddingWorkerCore({
      sendToMain: (d) => posted.push(d),
      setup: async () => ({ db: newItemDb(), pipeline: fakePipeline() }),
    });
    core.handleMessage({ type: "embed_texts", id: "x", texts: ["a"] });
    core.handleMessage({ type: "embed_item", itemId: "i1" });
    expect(posted).toHaveLength(0);
  });

  it("ignores unknown / malformed message types without throwing", async () => {
    const { posted } = await initReadyCore(async () => ({
      db: newItemDb(),
      pipeline: fakePipeline(),
    }));
    const before = posted.length;
    expect(() => core_handleUnknown(posted)).not.toThrow();
    function core_handleUnknown(_p: unknown[]): void {
      // built below from the same core via closure replacement is overkill; instead re-init inline:
    }
    expect(posted.length).toBe(before);
  });

  it("posts embed_texts_result ok:true with array vectors", async () => {
    const v = new Float32Array([0.1, 0.2]);
    const pipeline = fakePipeline({ embedTexts: async () => [v] });
    const posted: unknown[] = [];
    let got!: () => void;
    const resultP = new Promise<void>((r) => {
      got = r;
    });
    const core = new EmbeddingWorkerCore({
      sendToMain: (d) => {
        posted.push(d);
        if (isType(d, "embed_texts_result")) got();
      },
      setup: async () => ({ db: newItemDb(), pipeline }),
    });
    // init then await ready via backfill_done
    await new Promise<void>((res) => {
      const c2 = new EmbeddingWorkerCore({
        sendToMain: () => {},
        setup: async () => ({ db: newItemDb(), pipeline }),
      });
      void c2;
      res();
    });
    core.handleMessage(INIT);
    // wait until ready (a ready post) then send embed_texts
    await Promise.resolve();
    core.handleMessage({ type: "embed_texts", id: "abc", texts: ["hello"] });
    await resultP;
    expect(posted).toContainEqual({
      type: "embed_texts_result",
      id: "abc",
      ok: true,
      vectors: [[0.1, 0.2].map((n) => Math.fround(n))],
    });
  });

  it("posts embed_texts_result ok:false on embedder error", async () => {
    const pipeline = fakePipeline({
      embedTexts: async () => {
        throw new Error("embed boom");
      },
    });
    const { core, posted } = await initReadyCore(async () => ({ db: newItemDb(), pipeline }));
    let got!: () => void;
    const p = new Promise<void>((r) => {
      got = r;
    });
    // re-route: append a listener by wrapping is not possible; instead poll the array deterministically
    core.handleMessage({ type: "embed_texts", id: "e1", texts: ["x"] });
    // embed_texts spawns async work; drain the microtask + the awaited rejection
    await core.idle();
    void p;
    void got;
    expect(
      posted.some((d) => isType(d, "embed_texts_result") && (d as { ok?: boolean }).ok === false),
    ).toBe(true);
  });

  it("embed_item: embeds a found row, skips a missing row", async () => {
    const embedded: string[] = [];
    const pipeline = fakePipeline({
      embedItem: async (item) => {
        embedded.push(item.id);
      },
    });
    const db = newItemDb([{ id: "i1" }]);
    const { core } = await initReadyCore(async () => ({ db, pipeline }));
    core.handleMessage({ type: "embed_item", itemId: "i1" });
    core.handleMessage({ type: "embed_item", itemId: "missing" });
    await core.idle();
    expect(embedded).toEqual(["i1"]); // missing row is skipped, no throw
  });

  it("embed_item queue keeps draining after a failed task (no unhandled rejection)", async () => {
    const embedded: string[] = [];
    let first = true;
    const pipeline = fakePipeline({
      embedItem: async (item) => {
        if (first) {
          first = false;
          throw new Error("first task boom");
        }
        embedded.push(item.id);
      },
    });
    const db = newItemDb([{ id: "a" }, { id: "b" }]);
    const { core } = await initReadyCore(async () => ({ db, pipeline }));
    core.handleMessage({ type: "embed_item", itemId: "a" }); // rejects, swallowed
    core.handleMessage({ type: "embed_item", itemId: "b" }); // must still run
    await core.idle();
    expect(embedded).toEqual(["b"]); // queue not wedged; failure was silent best-effort
  });
});
```

> NOTE for the implementer: the test above has two intentionally-rough spots (`core_handleUnknown` and the embed_texts ok:true `await Promise.resolve()` readiness) that you MUST tighten in Step 3 once the core API is real: (1) for the unknown-message test, send `core.handleMessage({ type: "nope" } as unknown as InMsg)` to a ready core and assert `posted.length` is unchanged and no throw; (2) for embed_texts tests, use the `initReadyCore(...)` helper to get a guaranteed-ready core, then send `embed_texts` and `await core.idle()`. Replace the placeholder scaffolding with the helper. The `idle()` / readiness contract is defined by the core in Step 3.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/src/embedding/embedding-worker-core.test.ts`
Expected: FAIL — `Cannot find module './embedding-worker-core.ts'`.

- [ ] **Step 3: Write `packages/gateway/src/embedding/embedding-worker-core.ts`**

```ts
import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import type { IndexedItem } from "./types.ts";

export type InitMsg = {
  type: "init";
  dbPath: string;
  cacheDir: string;
  toml: Pick<NimbusEmbeddingToml, "chunkTokens" | "chunkOverlapTokens" | "backfillBatchSize">;
};
export type EmbedTextsMsg = { type: "embed_texts"; id: string; texts: string[] };
export type EmbedItemMsg = { type: "embed_item"; itemId: string };
export type InMsg = InitMsg | EmbedTextsMsg | EmbedItemMsg;

/** Minimal structural seam — the real `bun:sqlite` Database is assignable. */
export interface EmbeddingWorkerDb {
  query(sql: string): { get(id: string): unknown };
}

/** Minimal structural seam — the real SqliteEmbeddingPipeline is assignable. */
export interface EmbeddingWorkerPipeline {
  embedTexts(texts: string[]): Promise<Float32Array[]>;
  embedItem(item: IndexedItem): Promise<void>;
  backfillAll(onProgress?: (done: number, total: number) => void): Promise<void>;
}

export type EmbeddingWorkerSetup = (
  msg: InitMsg,
) => Promise<{ db: EmbeddingWorkerDb; pipeline: EmbeddingWorkerPipeline }>;

export interface EmbeddingWorkerDeps {
  sendToMain: (data: unknown) => void;
  setup: EmbeddingWorkerSetup;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The embedding worker's stateful orchestration, extracted from `embedding-worker.ts` so it is
 * unit-testable without the Worker realm (the istanbul `[test].preload` plugin cannot reach a
 * Worker realm — see the §5.3 probe). Behavior is identical to the pre-extraction worker; the
 * residual `embedding-worker.ts` is a thin wiring shell that constructs the real deps and routes
 * origin-validated messages here.
 */
export class EmbeddingWorkerCore {
  private readonly sendToMain: (data: unknown) => void;
  private readonly setup: EmbeddingWorkerSetup;
  private db: EmbeddingWorkerDb | null = null;
  private pipeline: EmbeddingWorkerPipeline | null = null;
  private ready = false;
  // Serialized embed_item queue. The tail `.catch` guarantees the chain always RESOLVES, so the
  // queue can never wedge; embed_item failures are intentionally silent best-effort (no result id
  // to correlate, unlike embed_texts). `inFlight` tracks init/embed_texts detached work for tests.
  private embedChain: Promise<void> = Promise.resolve();
  private inFlight: Promise<void> = Promise.resolve();

  constructor(deps: EmbeddingWorkerDeps) {
    this.sendToMain = deps.sendToMain;
    this.setup = deps.setup;
  }

  handleMessage(msg: InMsg): void {
    if (msg.type === "init") {
      this.track(this.handleInit(msg));
      return;
    }
    if (!this.ready || this.pipeline === null || this.db === null) {
      return;
    }
    if (msg.type === "embed_texts") {
      this.track(this.handleEmbedTexts(this.pipeline, msg));
      return;
    }
    if (msg.type === "embed_item") {
      this.handleEmbedItem(this.db, this.pipeline, msg);
    }
    // Unknown/malformed types fall through to a no-op (ignored, no throw).
  }

  /** Test seam: await all detached init/embed_texts work AND the serialized embed_item queue. */
  async idle(): Promise<void> {
    await this.inFlight;
    await this.embedChain;
    await this.inFlight;
  }

  private track(p: Promise<void>): void {
    this.inFlight = this.inFlight.then(() => p).catch(() => undefined);
  }

  private async handleInit(msg: InitMsg): Promise<void> {
    try {
      const { db, pipeline } = await this.setup(msg);
      this.db = db;
      this.pipeline = pipeline;
      this.ready = true;
      this.sendToMain({ type: "ready" });
      await this.runBackfill(pipeline);
    } catch (err) {
      this.sendToMain({ type: "init_error", message: errMessage(err) });
    }
  }

  private async runBackfill(pipeline: EmbeddingWorkerPipeline): Promise<void> {
    let success = false;
    try {
      await pipeline.backfillAll((done, total) => {
        this.sendToMain({ type: "backfill_progress", done, total });
      });
      success = true;
    } catch {
      /* best-effort */
    }
    this.sendToMain({ type: "backfill_done", success });
  }

  private async handleEmbedTexts(
    pipeline: EmbeddingWorkerPipeline,
    msg: EmbedTextsMsg,
  ): Promise<void> {
    try {
      const vectors = await pipeline.embedTexts(msg.texts);
      this.sendToMain({
        type: "embed_texts_result",
        id: msg.id,
        ok: true,
        vectors: vectors.map((v) => Array.from(v)),
      });
    } catch (err) {
      this.sendToMain({
        type: "embed_texts_result",
        id: msg.id,
        ok: false,
        error: errMessage(err),
      });
    }
  }

  private handleEmbedItem(
    db: EmbeddingWorkerDb,
    pipeline: EmbeddingWorkerPipeline,
    msg: EmbedItemMsg,
  ): void {
    const itemId = msg.itemId;
    this.embedChain = this.embedChain
      .then(async () => {
        const row = db
          .query("SELECT id, service, type, title, body_preview FROM item WHERE id = ?")
          .get(itemId) as IndexedItem | null | undefined;
        if (row === null || row === undefined) {
          return;
        }
        await pipeline.embedItem(row);
      })
      .catch(() => {
        /* best-effort: a failed embed must not wedge the serialized queue */
      });
  }
}
```

> The `idle()` test seam awaits `inFlight` (init + embed_texts detached work) then the embed_item queue then `inFlight` again (covers init-triggered backfill that posts after re-entrancy). The `initReadyCore` helper still keys readiness off the `backfill_done` post — but tests for embed_texts/embed_item may also simply `await core.idle()` after sending, which is the robust path. Tighten the Step-1 placeholders to use `initReadyCore` + `await core.idle()`.

- [ ] **Step 4: Tighten the Step-1 placeholders**, then run the test

Replace the rough `embed_texts ok:true` and unknown-message tests with the `initReadyCore` + `await core.idle()` form (see the Step-1 NOTE). Then run:

```bash
bun test packages/gateway/src/embedding/embedding-worker-core.test.ts
```

Expected: PASS (all cases). If a readiness race appears, prefer `await core.idle()` over microtask `await Promise.resolve()`.

- [ ] **Step 5: Reduce `embedding-worker.ts` to a wiring shell**

Replace the entire body of `packages/gateway/src/embedding/embedding-worker.ts` with:

```ts
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";
import { LocalIndex } from "../index/local-index.ts";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { ensureSqliteVecForConnection } from "../index/sqlite-vec-load.ts";
import { isAcceptableWorkerOrigin } from "../platform/worker-security.ts";
import { EmbeddingWorkerCore, type InitMsg, type InMsg } from "./embedding-worker-core.ts";
import { createLocalEmbedder } from "./model.ts";
import { SqliteEmbeddingPipeline } from "./pipeline.ts";

function sendToMain(data: unknown): void {
  const w = globalThis as unknown as { postMessage?: (d: unknown) => void };
  w.postMessage?.(data);
}

function setupDb(dbPath: string): Database {
  const d = new Database(dbPath);
  d.run("PRAGMA busy_timeout = 8000");
  const dir = dirname(dbPath);
  runIndexedSchemaMigrations(d, LocalIndex.SCHEMA_VERSION, {
    backupDir: join(dir, "backups"),
    dbPath,
  });
  ensureSqliteVecForConnection(d, readIndexedUserVersion(d));
  d.run("PRAGMA foreign_keys = ON");
  return d;
}

const core = new EmbeddingWorkerCore({
  sendToMain,
  setup: async (msg: InitMsg) => {
    const db = setupDb(msg.dbPath);
    const embedder = await createLocalEmbedder({ cacheDir: msg.cacheDir });
    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder,
      backfillBatchSize: msg.toml.backfillBatchSize,
      chunkOptions: {
        maxChunkTokens: msg.toml.chunkTokens,
        overlapTokens: msg.toml.chunkOverlapTokens,
      },
    });
    return { db, pipeline };
  },
});

// The origin check is the realm boundary; the core operates on already-validated, parsed payloads.
(globalThis as unknown as { onmessage: ((ev: MessageEvent<InMsg>) => void) | null }).onmessage = (
  ev: MessageEvent<InMsg>,
) => {
  if (!isAcceptableWorkerOrigin(ev)) {
    return;
  }
  core.handleMessage(ev.data);
};
```

- [ ] **Step 6: Typecheck + run the embedding suite + invariants**

Run:

```bash
bun run --filter '@nimbus-dev/gateway' typecheck
bun test packages/gateway/src/embedding/
bun test packages/gateway/src/security-invariants.test.ts
bun run audit:invariants
```

Expected: typecheck clean (the real `Database`/`SqliteEmbeddingPipeline` are assignable to the structural seams); embedding suite PASS; `security-invariants.test.ts` 69/69; `audit:invariants` exit 0.

- [ ] **Step 7: Biome the changed files**

Run: `bunx biome check packages/gateway/src/embedding/embedding-worker-core.ts packages/gateway/src/embedding/embedding-worker-core.test.ts packages/gateway/src/embedding/embedding-worker.ts`
Expected: no errors (no `any`, imports ordered).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/embedding/ && git commit -m "refactor(embedding): extract EmbeddingWorkerCore (DI-seamed, unit-tested)

Residual embedding-worker.ts is a thin wiring shell (stays excluded);
behavior unchanged. Origin check stays in the residual onmessage."
```

---

## Task 5: Resolve the §5.3 worker-realm probe (time-boxed) + document `query-guard-worker.ts`

Per the spec, after extraction try the deferred worker-realm instrumentation probe on the residual `embedding-worker.ts` (and `query-guard-worker.ts`). Decision rule: if a worker-side preload re-register + `__coverage__` flush is cheap and yields a valid BRDA flush for the worker file, instrument it and drop the exclusion; otherwise the documented thin-shell exclusion stands. **Time-box: ~45 min. The documented exclusion is the guaranteed fallback** — do not rabbit-hole.

**Files:** (investigation) possibly a worker-side preload under `scripts/coverage/`; otherwise comment-only in `scripts/coverage-floor/exclusions.ts`.

- [ ] **Step 1: Spike the probe** — write a throwaway worker-side preload that re-registers the istanbul instrumenter (the same `scripts/coverage/istanbul-register.*` plugin used in `[test].preload`) inside a Worker, runs one `embed_texts` round-trip against the residual worker, and posts `globalThis.__coverage__` back to the main realm for merge. Reference: the umbrella program spec §5.3 and `scripts/coverage/` preloads.

- [ ] **Step 2: Decide**

  - If the flush produces valid BRDA for `embedding-worker.ts`: wire the worker-side preload durably, drop the `embedding-worker.ts` exclusion, reseed (Task 8 covers it), and document the mechanism in `docs/contributors/coverage.md`.
  - If it does not (separate realm can't be reached cheaply, or the flush is empty/unreliable): **keep both worker exclusions** and write the documented outcome. This is the expected result (parity with Bun native `--coverage`, which also misses workers).

- [ ] **Step 3: Document the outcome** in `scripts/coverage-floor/exclusions.ts` — for the worker block:

```ts
  // Bun Workers run in a separate realm the istanbul `[test].preload` plugin cannot reach (parity
  // with Bun's native --coverage, which also misses workers). §5.3 probe (D3, 2026-06-14): a
  // worker-side preload re-register + __coverage__ flush was attempted; <OUTCOME>. The meaningful
  // orchestration was extracted to the unit-tested `embedding-worker-core.ts`, leaving:
  // - `embedding-worker.ts`: a thin wiring shell (constructs real deps, routes origin-validated msgs).
  // - `query-guard-worker.ts`: a genuinely-thin onmessage (security check lives in worker-security.ts;
  //   opens a readonly DB, runs the SQL, posts back) — nothing to extract.
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },
```

Replace `<OUTCOME>` with the actual finding (e.g. "the flush could not be reliably captured cross-realm → documented exclusion stands" or "succeeded → embedding-worker.ts un-excluded").

- [ ] **Step 4: Typecheck the exclusions module** (`bun -e "import './scripts/coverage-floor/exclusions.ts'; console.log('ok')"`). Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/coverage-floor/exclusions.ts docs/contributors/coverage.md 2>/dev/null; git add -A
git commit -m "docs(coverage): resolve §5.3 worker-realm probe (<outcome>); document worker exclusions"
```

---

## Task 6: Group the 11 type-only entries + add per-file guardian headers

Consolidate the 11 type-only / zero-SF entries into one labeled block, verify each genuinely emits no `SF:` record, and add a 3-line guardian header to each file.

**The 11 files:** `index/ranked-item.ts`, `embedding/embedding-runtime.ts`, `vault/nimbus-vault.ts`, `ipc/agent-invoke.ts`, `ipc/workflow-invoke.ts`, `connectors/mapped-row.ts`, `ipc/connector-rpc-handlers/context.ts`, `connectors/lazy-mesh/slot.ts`, `client/src/stream-events.ts`, `chatops/transport/transport.ts`, `ipc/server/options.ts` (all under `packages/gateway/src/` except `client/src/stream-events.ts`).

- [ ] **Step 1: Verify each is genuinely zero-SF** (don't trust the label)

Run (for each path): `bun -e "const s=await Bun.file('<path>').text(); console.log('<path>', /\b(function|class|=>|const \w+\s*=\s*[^;]*\(|export function)\b/.test(s) ? 'HAS-CODE?' : 'type-only-likely')"`

Better, authoritative check: any file with executable statements emits an `SF:` record under instrumentation. After the Task 8 Docker dry-run produces `coverage/lcov.info`, grep it: `grep -c "SF:.*<basename>" coverage/lcov.info` should be 0 for each. For now, manually read each file and confirm it is `export type` / `export interface` / `import type` only (no runtime `const`/`function`/`class` with a body). **If any has executable lines, it is mis-categorized — handle it as an I/O shell (own follow-up), do not group it.**

- [ ] **Step 2: Add the guardian header** to each of the 11 files (top of file, after any license banner):

```ts
// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
```

- [ ] **Step 3: Group the entries** in `scripts/coverage-floor/exclusions.ts` — replace the scattered type-only entries (and the individual `transport.ts` / `ipc/server/options.ts` comment blocks) with one block:

```ts
  // ── Type-only / zero-executable-line modules ──────────────────────────────────────────────────
  // These emit NO `SF:` lcov record (no executable statements) → the gate reads them as 0% and they
  // can NEVER rejoin the floor — same class as the `types.ts` / `-types.ts` basenameRegex below. There
  // is nothing to test. Each file carries a guardian header forbidding runtime logic. No rename
  // (avoids import churn across every consumer for marginal gain).
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/mapped-row.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  { kind: "exact", path: "packages/gateway/src/chatops/transport/transport.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  { kind: "exact", path: "packages/client/src/stream-events.ts" },
  // ──────────────────────────────────────────────────────────────────────────────────────────────
```

(Remove the old individual `transport.ts` and `ipc/server/options.ts` comment blocks; they fold into this group.)

- [ ] **Step 4: Typecheck the changed source files + exclusions**

Run: `bun run --filter '@nimbus-dev/gateway' typecheck && bun run --filter '@nimbus-dev/client' typecheck && bun -e "import './scripts/coverage-floor/exclusions.ts'; console.log('ok')"`
Expected: clean (header comments are inert); `ok`.

- [ ] **Step 5: Biome** the 11 changed files. Run `bunx biome check <the 11 paths>`. Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "docs(coverage): group 11 type-only exclusions + add guardian headers"
```

---

## Task 7: Full category-comment pass + verify the 2 debt files

Ensure every remaining exclusion sits in a labeled category block (FFI, platform-gated, boot/entry, mock.module-shadowed, workers, generated SQL, connect-shells, perf/native, UI/Ink, CLI IPC shells, env-gated mock, real-subprocess). Verify the 2 debt files are absent (no-op).

**Files:** Modify `scripts/coverage-floor/exclusions.ts` (comments + grouping only — no entry removals beyond prior tasks).

- [ ] **Step 1: Reorganize `exclusions.ts` into labeled category blocks** matching spec §3(d). Each block gets a one-line header comment, e.g.:

```ts
  // ── FFI (Vault) — DPAPI / Keychain / libsecret native bindings ──
  { kind: "exact", path: "packages/gateway/src/vault/win32.ts" },
  // …
  // ── Platform-gated — OS-specific; a single CI-Linux runner takes one branch per OS ──
  // ── Boot orchestrators / index barrels / factories / process entry points ──
  // ── mock.module-shadowed (real logic tested via the gateway-process.ts twin) ──
  // ── Workers (separate realm; see §5.3) ──
  // ── Generated SQL (pathRegex) ──
  // ── Connect-shell regexes (MCP connector server/tools, github-actions main) ──
  // ── Benchmarks / native ──
  // ── UI / React-Ink entry ──
  // ── CLI IPC shells (cores covered; residual runX = IPCClient + process.exit) ──
  // ── Type-only / zero-SF (Task 6 block) ──
```

Keep all existing entries; only add/normalize comments and ordering. Do NOT remove any entry that earlier tasks didn't explicitly drop.

- [ ] **Step 2: Verify the 2 debt files are absent**

Run:

```bash
grep -nE "gmail/history|gmail-sync" scripts/coverage-floor/exclusions.ts || echo "absent-from-exclusions: OK"
grep -nE "gmail/history|gmail-sync" docs/structure-audit/coverage-baseline.json || echo "absent-from-baseline: OK"
```

Expected: both print the `OK` line (the files cleared the floor in B6; no exclusion, no baseline entry).

- [ ] **Step 3: Run the exclusion-parity / isExempt tests**

Run: `bun test scripts/coverage-floor/`
Expected: PASS (the exclusion-list tests + isExempt tests still green after grouping; if a test asserts an exact pattern count, update it to the new count — note in the commit).

- [ ] **Step 4: Typecheck** (`bun -e "import './scripts/coverage-floor/exclusions.ts'; console.log('ok')"`). Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "docs(coverage): category-comment pass over exclusions; verify debt files cleared"
```

---

## Task 8: Docker dry-run + reseed + close-out (CHANGELOG + memory)

Confirm on Linux-istanbul that `EmbeddingWorkerCore` clears ≥80% and `files` stays `{}`, then write the program-close docs.

**Files:** `docs/structure-audit/coverage-baseline.json` (reseed — expect no change), `docs/CHANGELOG.md`, memory files (outside the repo).

- [ ] **Step 1: Docker dry-run** (Linux-authoritative)

Run: `bash scripts/coverage-floor/reseed-docker.sh` (oven/bun:latest; installs git/libsecret/keyring/dbus; runs build-lcov.sh under the dbus shim; `CI=true`).
Expected: `coverage-floor: ok (0 baselined; N scanned)` and the produced `coverage/lcov.info` shows `embedding-worker-core.ts` ≥80% line+branch. Confirm `embedding-worker.ts` and `query-guard-worker.ts` have no `SF:` record (excluded) and the 11 type-only files have no `SF:` record.

- [ ] **Step 2: Measure diff-coverage for the new core (Sonar `new_coverage` proxy)**

Per the D2 recipe: intersect `git diff origin/main HEAD` new-side line numbers for `embedding-worker-core.ts` with the `DA:` records in `coverage/lcov.info`. Expected: ≥80% of the new core's added lines are covered. If below, add tests for the uncovered branches before pushing (the core is fully DI-seamed, so this should be high).

- [ ] **Step 3: Confirm baseline unchanged**

Run: `bun run audit:coverage-floor:update-baseline` then `git diff docs/structure-audit/coverage-baseline.json`.
Expected: NO change — `files` stays `{}`, `targets` (executor/envelope @100) round-trip verbatim. If the diff is non-empty, an un-excluded file landed <80 (a failed honest-shrink call) — revert that un-exclude to documented.

- [ ] **Step 4: Write the CHANGELOG entry** in `docs/CHANGELOG.md` (top of the unreleased section):

```markdown
- **True Coverage D3 (program close):** relocated 4 test-helpers under `testing/` (self-enforcing
  exemption), deleted the redundant `sandbox-probe.ts` exclusion, corrected the
  `chatops-tool-runner-e2e-sink.ts` comment (production-imported, not test-only), grouped the 11
  type-only exclusions with per-file guardian headers, extracted a DI-seamed `EmbeddingWorkerCore`
  (unit-tested; residual `embedding-worker.ts` stays a thin wiring shell), resolved the §5.3
  worker-realm probe, and completed the per-category exclusion documentation. **The True Coverage
  program (A · B · ★ Flagship · C · D) is COMPLETE** — every non-flagship source file clears the
  ≥80% line+branch floor or carries a category-justified exclusion; `coverage-baseline.json` `files`
  is `{}`; the flagship `targets` (executor/envelope) hold at 100/100.
```

- [ ] **Step 5: Markdown lint** (CI gate). Run: `bun run lint:markdown` from inside the worktree; read the output. Fix any MD004 (`+`-as-bullet → comma prose) / MD031 / MD040 manually. No absolute `file:///` links.

- [ ] **Step 6: Full local preflight** (ship-readiness — before the first push)

Run: `bun run preflight` (full CI parity). Also build coverage lcov + run the floor gate (`scripts/coverage-floor/`), `lychee` on changed docs, and a whole-branch `/code-review`. Expected: all green.

- [ ] **Step 7: Commit + push**

```bash
git add -A && git commit -m "docs: True Coverage D3 close-out — CHANGELOG; program COMPLETE"
git push -u origin dev/asafgolombek/true-coverage-D3
```

- [ ] **Step 8: Open the PR, reseed from the PR's own merge-lcov**

After CI runs: `gh run download <pr-run-id> -n coverage-lcov-merged` → copy to `coverage/lcov.info` → `bun run audit:coverage-floor:update-baseline` → confirm `git diff` of the baseline is empty (`files: {}`, `targets` intact). Commit only if the merge-lcov reseed differs from local (it should not). Push.

- [ ] **Step 9: Update the memory** (`true-coverage-program-workstream.md` + `MEMORY.md`): record D3 merged, **PROGRAM COMPLETE (A ✅ B ✅ ★ ✅ C ✅ D ✅)**, the §5.3 probe outcome, and the deferred 5.2 check.ts-AST-gate follow-up.

---

## Self-Review

**Spec coverage:** §3.A relocations → Task 1. §3.B sandbox-probe delete → Task 2. §3.C comment correction → Task 3. §3.E EmbeddingWorkerCore → Task 4. §6/§5.3 probe + query-guard doc → Task 5. §3.D type-only grouping + 5.1 guardian headers + zero-SF verify → Task 6. §3.F category docs + §3.G debt-file verify → Task 7. §4 coverage mechanics + reseed + close-out → Task 8. All spec sections mapped.

**Placeholder scan:** Task 4 Step 1 contains two intentionally-rough test scaffolds (flagged with an explicit NOTE + Step 4 tightening instruction using the real `idle()`/`initReadyCore` contract) — this is a guided refinement, not an unfilled placeholder. Task 5's `<OUTCOME>` and Task 8 `<pr-run-id>` are runtime-determined values, correctly marked. No "TBD/handle edge cases/add validation" placeholders remain.

**Type consistency:** `EmbeddingWorkerCore`, `EmbeddingWorkerDeps`, `EmbeddingWorkerSetup`, `EmbeddingWorkerDb`, `EmbeddingWorkerPipeline`, `InitMsg`/`InMsg`/`EmbedTextsMsg`/`EmbedItemMsg`, `handleMessage`, `idle()` are used consistently across the test (Task 4 Step 1), the core (Step 3), and the residual shell (Step 5). The seam types match the real `Database`/`SqliteEmbeddingPipeline` signatures verified from `pipeline.ts` / `model.ts`.
