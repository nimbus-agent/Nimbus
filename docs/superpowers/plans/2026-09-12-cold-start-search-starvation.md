# Cold-Start Search Starvation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A search issued while the embedding backfill is running returns promptly — semantically ranked when possible, keyword-only with an explicit disclosure when not — instead of timing out at 30 s or silently degrading to BM25 and reporting the result as complete.

**Architecture:** Three independent layers. (1) A permit gate inside the embedding worker admits an interactive `embed_texts` ahead of queued background work, covering both background producers — `backfillAll` and the `embed_item` chain. (2) The bridge's query timeout drops 60 s → 5 s and throws a typed error instead of resolving `null`, killing the false green. (3) `LocalIndex.searchRankedAsync` constructs a retrieval-quality disclosure at the one site that knows both facts and returns it in an envelope to every in-process caller; the IPC layer unwraps to a bare array unless the request opts in, so the published wire contract is untouched.

**Tech Stack:** Bun 1.2+ / TypeScript 7 strict · `bun:sqlite` · `bun:test` · `@xenova/transformers` + `onnxruntime-node` (local MiniLM embedder) · JSON-RPC 2.0 over a Unix socket / named pipe

**Spec:** `docs/superpowers/specs/2026-09-12-cold-start-search-starvation-design.md`
(with `…-review.md` beside it — the cross-model review whose accepted items are folded in)

## Global Constraints

- **No `any`.** External data enters as `unknown` and is narrowed. TypeScript strict is non-negotiable.
- **`exactOptionalPropertyTypes` is on.** Never pass `{ key: undefined }` for an optional property — omit the key, or build the object conditionally. This bites in every options object below.
- **No new security invariant, no schema migration, no new TOML config key.** The timeout takes an env override only (`NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS`).
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Verification before every push:** `bun run preflight:fast`. If logic or tests changed, also run the scoped suite named in the task.
- **Commit on the branch, never `main`.** Branch: `dev/asafgolombek/cold-start-search`.
- **Neither the spec, the review, nor this plan reaches `main`.** All three are deleted from the branch before PR 1 opens; squash takes the net tree diff. Anything durable goes to `docs/architecture.md` first.
- **Timing assertions:** CI runners are ~13–18× slower than a dev machine at temp-dir SQLite work. Prefer ordering/counting assertions over wall-clock ones. Where a wall-clock bound is unavoidable, it belongs in the opt-in harness (Task 1), not in a CI test.

**A path in backticks is a file that exists today and is gated by `audit:doc-refs`;
a path written bare is one this plan creates.** That distinction is load-bearing: the
gate extracts references from inline code spans, so backticking a not-yet-created file
would red the build, while leaving existing paths bare would stop the gate catching them
when they rot.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| packages/gateway/src/embedding/priority-gate.ts | The permit gate. Pure scheduling logic, no I/O, no embedding knowledge. |
| packages/gateway/src/embedding/priority-gate.test.ts | Unit tests for the gate's admission semantics. |
| packages/gateway/src/index/search-disclosure.ts | `SearchRetrievalDisclosure` / `SearchRankedEnvelope` types + the one constructor for them. |
| packages/gateway/src/index/search-disclosure.test.ts | Unit tests for disclosure construction. |
| packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts | Opt-in measurement against the REAL embedder. Answers spec §7. Never runs in CI. |

**Modified files**

| File | Change |
|---|---|
| `packages/gateway/src/embedding/pipeline.ts` | Accept an optional `priorityGate`; acquire a background permit per item in `embedBatch`. |
| `packages/gateway/src/embedding/embedding-worker-core.ts` | Own the gate; `embed_texts` acquires interactive, `embed_item` acquires background. |
| `packages/gateway/src/embedding/embedding-worker.ts` | Pass the core's gate into the constructed pipeline. |
| `packages/gateway/src/embedding/embedding-readiness.ts` | Add `EmbeddingTimeoutError`, its code/RPC code, its brand guard, and `embedQueryDualBestEffortReported`. |
| `packages/gateway/src/embedding/worker-bridge.ts` | Query timeout 60 s → 5 s + env override; throw instead of `resolve(null)`. |
| `packages/gateway/src/index/local-index.ts` | `searchRankedAsync` returns `SearchRankedEnvelope`; optional `embedQueryDualReported` seam. |
| `packages/gateway/src/platform/assemble.ts` | Wire `embedQueryDualReported`; pass backfill progress into the index. |
| `packages/gateway/src/ipc/server/inline-handlers.ts` | Unwrap the envelope unless `params.envelope === true`. |
| `packages/gateway/src/engine/run-ask.ts`, `engine/agent.ts`, `briefs/brief-index-search.ts`, `toolgen/toolgen-grounding.ts` | Read `.items` off the envelope. |
| `packages/cli/src/commands/search.ts` | Pass `envelope: true`; keep stdout an array; disclosure to stderr. |
| `packages/cli/src/mcp/adapter.ts` | Pass `envelope: true`; carry the disclosure into the tool output. |

---

## PR 1 — Reproduction and admission control

## Task 1: Opt-in measurement harness

Answers spec §7 — whether ONNX inference blocks the worker's JS thread or is offloaded — with a real number instead of an inference. It is **opt-in and never runs in CI**: it needs the real MiniLM model on disk and it makes wall-clock assertions, both of which are disqualifying for the shared matrix. The implementer runs it once, records the number in the PR body and in spec §7.

**Files:**

- Create: packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts

**Interfaces:**

- Consumes: nothing (first task).
- Produces: no code other tasks import. Produces a **measured latency figure** that Task 4's assertion threshold and the PR body both cite.

- [ ] **Step 1: Write the harness**

Gated on an explicit env opt-in, following `packages/gateway/test/e2e/scenarios/discovery-mdns.e2e.test.ts`'s `skipIf` shape.

```typescript
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteEmbeddingPipeline } from "../../../src/embedding/pipeline.ts";
import { loadFeatureExtractionPipeline } from "../../../src/embedding/load-feature-extraction-pipeline.ts";
import { createLocalEmbedder } from "../../../src/embedding/model.ts";

/**
 * Opt-in: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding`.
 *
 * Never runs in CI, for two independent reasons: it downloads/loads the real MiniLM model,
 * and it asserts wall-clock latency on a machine whose speed CI does not control.
 */
const RUN = process.env["NIMBUS_RUN_EMBED_HARNESS"] === "1";

describe.skipIf(!RUN)("query latency under a saturating backfill (measurement)", () => {
  it("records how long a query embed waits while backfill runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-embed-harness-"));
    try {
      const db = new Database(join(dir, "index.db"));
      seedItems(db, 5_000);

      const embedder = await createLocalEmbedder({ cacheDir: join(dir, "models") });
      const pipeline = new SqliteEmbeddingPipeline({ db, embedder, backfillConcurrency: 8 });

      // Start the backfill and let it reach steady state before measuring.
      const backfill = pipeline.backfillAll();
      await Bun.sleep(2_000);

      const t0 = performance.now();
      await pipeline.embedTexts(["how does the deploy pipeline work"]);
      const underLoadMs = performance.now() - t0;

      // POSITIVE CONTROL. Without an idle baseline from the SAME machine and model,
      // "slow" is unfalsifiable — a big number could just be a slow laptop.
      await backfill;
      const t1 = performance.now();
      await pipeline.embedTexts(["how does the deploy pipeline work"]);
      const idleMs = performance.now() - t1;

      console.log(
        `[harness] query embed: under load ${underLoadMs.toFixed(0)}ms, idle ${idleMs.toFixed(0)}ms, ratio ${(underLoadMs / idleMs).toFixed(1)}x`,
      );

      // The DEFECT assertion: today the loaded case is dramatically worse. This harness
      // exists to make that number real, so it asserts only that the gap is observable.
      expect(underLoadMs).toBeGreaterThan(idleMs * 2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});

function seedItems(db: Database, n: number): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS item (
       id TEXT PRIMARY KEY, service TEXT, type TEXT, title TEXT, body_preview TEXT
     )`,
  );
  const insert = db.prepare(
    "INSERT INTO item (id, service, type, title, body_preview) VALUES (?, ?, ?, ?, ?)",
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i += 1) {
      insert.run(`item-${String(i)}`, "github", "issue", `Issue ${String(i)}`, `Body text ${String(i)} about deploys and rollbacks.`);
    }
  });
  tx();
  insert.finalize();
}
```

> `insert.finalize()` is not optional housekeeping: an unfinalized `prepare()` makes `db.close()` a silent no-op, and the temp dir then fails to delete on Windows.

- [ ] **Step 2: Confirm it is skipped by default**

Run: `bun test packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts`
Expected: PASS with the test reported as skipped, 0 failures. This is the CI-safety check — if it executes here, the gating is wrong.

- [ ] **Step 3: Run it for real and record the number**

Run: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts`
Expected: PASS, and a `[harness]` line giving the under-load, idle and ratio figures. First run downloads ~25 MB of model.

Write the observed numbers into spec §7, replacing the "Unmeasured" bullet's body with the measurement and stating the machine it came from. If the ratio is **not** greater than 2×, stop and report — the premise of this whole plan is wrong and the design needs revisiting before any fix lands.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts docs/superpowers/specs/2026-09-12-cold-start-search-starvation-design.md
git commit -m "test(embedding): measure query latency under a saturating backfill"
```

---

## Task 2: The priority gate

Pure scheduling logic in its own file: no embedding knowledge, no I/O, so its semantics are testable without a model. **The behaviour that matters and is easy to get wrong: interactive work jumps the QUEUE, it does not wait for a full drain.** Blocking until `inFlightBackground === 0` makes a query wait for all 8 in-flight items — roughly 8× the intended bound.

**Files:**

- Create: packages/gateway/src/embedding/priority-gate.ts
- Test: packages/gateway/src/embedding/priority-gate.test.ts

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `export interface EmbeddingPriorityGate { acquireBackground(): Promise<() => void>; acquireInteractive(): Promise<() => void>; }`
  - `export class AsyncPriorityGate implements EmbeddingPriorityGate { constructor(maxBackground: number); }`
  - Both consumed by Tasks 3 and 4.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "bun:test";

import { AsyncPriorityGate } from "./priority-gate.ts";

describe("AsyncPriorityGate", () => {
  it("admits background work up to the permit count", async () => {
    const gate = new AsyncPriorityGate(2);
    const a = await gate.acquireBackground();
    const b = await gate.acquireBackground();

    let thirdAdmitted = false;
    void gate.acquireBackground().then(() => {
      thirdAdmitted = true;
    });
    await Bun.sleep(0);
    expect(thirdAdmitted).toBe(false);

    a();
    await Bun.sleep(0);
    expect(thirdAdmitted).toBe(true);
    b();
  });

  it("admits an interactive request WITHOUT waiting for in-flight background to drain", async () => {
    const gate = new AsyncPriorityGate(8);
    // Saturate: 8 background permits held and never released during this test.
    const held = [];
    for (let i = 0; i < 8; i += 1) {
      held.push(await gate.acquireBackground());
    }

    // The whole point. A full-drain implementation hangs here forever.
    const release = await gate.acquireInteractive();
    expect(typeof release).toBe("function");

    release();
    for (const h of held) h();
  });

  it("stops admitting NEW background work while an interactive request is pending", async () => {
    const gate = new AsyncPriorityGate(2);
    const first = await gate.acquireBackground();

    const interactive = await gate.acquireInteractive();

    let backgroundAdmitted = false;
    void gate.acquireBackground().then((r) => {
      backgroundAdmitted = true;
      r();
    });
    await Bun.sleep(0);
    expect(backgroundAdmitted).toBe(false);

    interactive();
    await Bun.sleep(0);
    expect(backgroundAdmitted).toBe(true);
    first();
  });

  it("resumes background admission after the last of several interactive requests finishes", async () => {
    const gate = new AsyncPriorityGate(1);
    const i1 = await gate.acquireInteractive();
    const i2 = await gate.acquireInteractive();

    let admitted = false;
    void gate.acquireBackground().then((r) => {
      admitted = true;
      r();
    });

    i1();
    await Bun.sleep(0);
    expect(admitted).toBe(false); // i2 still pending — one release is not enough

    i2();
    await Bun.sleep(0);
    expect(admitted).toBe(true);
  });

  it("releases idempotently, so a double release cannot inflate the permit pool", async () => {
    const gate = new AsyncPriorityGate(1);
    const release = await gate.acquireBackground();
    release();
    release();

    const second = await gate.acquireBackground();
    let thirdAdmitted = false;
    void gate.acquireBackground().then(() => {
      thirdAdmitted = true;
    });
    await Bun.sleep(0);
    expect(thirdAdmitted).toBe(false); // still capped at 1, not 2
    second();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/embedding/priority-gate.test.ts`
Expected: FAIL — `Cannot find module './priority-gate.ts'`.

- [ ] **Step 3: Write the gate**

```typescript
/**
 * Admission control for the embedding worker.
 *
 * One worker serves two populations: BACKGROUND embedding (the backfill loop and the
 * per-item sync queue) and INTERACTIVE embedding (a query typed by a human, waiting).
 * Without a gate they compete on equal terms, and background work wins by sheer volume —
 * the backfill holds `backfillConcurrency` inferences in flight continuously for as long
 * as the index takes to embed, which is hours on a real machine.
 *
 * The rule is deliberately asymmetric:
 *
 *   - Background work takes one of N permits and waits when they are gone.
 *   - Interactive work takes NO permit and never waits for one. It sets a flag that stops
 *     NEW background admissions, then proceeds immediately.
 *
 * Interactive work does NOT wait for in-flight background work to drain. That alternative
 * is tempting and wrong: at N=8 a query would wait for eight inferences to finish, which
 * is roughly eight times the bound this gate exists to establish. Running alongside
 * whatever is already in flight — while starving the queue behind it — gets the query
 * out in one item's remaining time.
 */
export interface EmbeddingPriorityGate {
  /** Background embedding. Resolves when a permit is free AND no interactive work is pending. */
  acquireBackground(): Promise<() => void>;
  /** Interactive embedding. Resolves immediately; suppresses new background admissions until released. */
  acquireInteractive(): Promise<() => void>;
}

export class AsyncPriorityGate implements EmbeddingPriorityGate {
  private readonly maxBackground: number;
  private inFlightBackground = 0;
  private interactivePending = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(maxBackground: number) {
    this.maxBackground = Math.max(1, maxBackground);
  }

  async acquireBackground(): Promise<() => void> {
    while (this.interactivePending > 0 || this.inFlightBackground >= this.maxBackground) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve);
      });
    }
    this.inFlightBackground += 1;
    return this.once(() => {
      this.inFlightBackground -= 1;
      this.wakeWaiters();
    });
  }

  async acquireInteractive(): Promise<() => void> {
    // No await before the increment: the suppression must be visible to any background
    // acquire that runs before this function's caller gets its turn on the microtask queue.
    this.interactivePending += 1;
    return this.once(() => {
      this.interactivePending -= 1;
      this.wakeWaiters();
    });
  }

  /**
   * Wraps a release so calling it twice is a no-op. A double release would decrement the
   * counter below its true value and permanently inflate the effective permit pool —
   * a slow leak that presents as "the gate stopped working" long after the offending call.
   */
  private once(fn: () => void): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      fn();
    };
  }

  /**
   * Wakes every waiter and lets each re-check its own condition. Deliberately not a
   * precise hand-off: a woken waiter that still cannot proceed simply re-queues, and the
   * re-check in `acquireBackground`'s `while` is what makes that safe. Precise hand-off
   * would need the gate to know which waiter wants what, for no behavioural gain at N≤8.
   */
  private wakeWaiters(): void {
    const woken = this.waiting.splice(0, this.waiting.length);
    for (const resolve of woken) resolve();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/embedding/priority-gate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Red-prove the queue-jump test**

Temporarily add `while (this.inFlightBackground > 0) { await new Promise<void>((r) => this.waiting.push(r)); }` to the top of `acquireInteractive`, after the increment. Re-run.
Expected: the "WITHOUT waiting for in-flight background to drain" test now **times out**. Revert the change and re-run to confirm PASS.

This step exists because that test is the one most likely to pass for the wrong reason — a gate that never blocks anything also passes it.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/embedding/priority-gate.ts packages/gateway/src/embedding/priority-gate.test.ts
git commit -m "feat(embedding): add the interactive-priority admission gate"
```

---

## Task 3: Wire the gate into the pipeline

**Files:**

- Modify: `packages/gateway/src/embedding/pipeline.ts`
- Test: `packages/gateway/src/embedding/pipeline.test.ts` (existing file — append)

**Interfaces:**

- Consumes: `EmbeddingPriorityGate` from Task 2.
- Produces: `SqliteEmbeddingPipelineOptions.priorityGate?: EmbeddingPriorityGate` — consumed by Task 4.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/embedding/pipeline.test.ts`.

**Note the vec gate.** Every suite in that file is `describe.skipIf(!VEC_AVAILABLE)` and these
must be too, since `embedItem` writes vectors. Consequence worth knowing before trusting a green
run: sqlite-vec does not load on macOS CI (issue #1029), so these assertions **do not execute
there**. The Linux and Windows legs are the ones that prove this task.

```typescript
// `freshDb`, `mockEmbedder` and `VEC_AVAILABLE` already exist in this file — use them
// rather than adding parallel helpers. Every suite here is vec-gated, and this one must be
// too: `embedItem` writes to `vec_items_384`.
function seed(db: Database, n: number): void {
  for (let i = 0; i < n; i += 1) {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview,
          modified_at, synced_at)
       VALUES (?, 'slack', 'message', ?, 'hello world', 'body text', ?, ?)`,
      [`slack:e${String(i)}`, `e${String(i)}`, Date.now(), Date.now()],
    );
  }
}

describe.skipIf(!VEC_AVAILABLE)("SqliteEmbeddingPipeline — backfill admission", () => {
  test("acquires and releases one background permit per item", async () => {
    const db = freshDb();
    seed(db, 3);
    const acquired: string[] = [];
    const gate = {
      acquireBackground: async () => {
        acquired.push("acquire");
        return () => {
          acquired.push("release");
        };
      },
      acquireInteractive: async () => () => {},
    };

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: mockEmbedder(384, "m"),
      priorityGate: gate,
    });
    await pipeline.backfillAll();

    expect(acquired.filter((a) => a === "acquire")).toHaveLength(3);
    expect(acquired.filter((a) => a === "release")).toHaveLength(3);
    db.close();
  });

  test("releases the permit even when embedding an item throws", async () => {
    const db = freshDb();
    seed(db, 1);
    let released = 0;
    const gate = {
      acquireBackground: async () => () => {
        released += 1;
      },
      acquireInteractive: async () => () => {},
    };

    const pipeline = new SqliteEmbeddingPipeline({
      db,
      embedder: {
        model: "fake",
        dims: 384,
        isLocal: true,
        embed: () => Promise.reject(new Error("boom")),
      },
      priorityGate: gate,
    });
    await pipeline.backfillAll();

    // A permit leaked on the error path deadlocks the backfill after N failures —
    // the exact failure mode a `finally` exists to prevent.
    expect(released).toBe(1);
    db.close();
  });

  test("backfills unchanged when no gate is supplied", async () => {
    const db = freshDb();
    seed(db, 2);
    const pipeline = new SqliteEmbeddingPipeline({ db, embedder: mockEmbedder(384, "m") });
    await pipeline.backfillAll();
    const row = db.query("SELECT COUNT(DISTINCT item_id) AS c FROM embedding_chunk").get() as {
      c: number;
    };
    expect(row.c).toBe(2);
    db.close();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/embedding/pipeline.test.ts`
Expected: FAIL — `priorityGate` is not a known option (typecheck error), and the acquire counts are 0.

- [ ] **Step 3: Implement**

In `packages/gateway/src/embedding/pipeline.ts`, add the import and the option:

```typescript
import type { EmbeddingPriorityGate } from "./priority-gate.ts";
```

Add to `SqliteEmbeddingPipelineOptions`, directly below `backfillGate`:

```typescript
  /**
   * Admission control for BACKGROUND embedding, so an interactive query can jump the queue.
   *
   * Distinct from `backfillGate` above and deliberately not merged with it: that one answers
   * "may the backfill run at all" (battery) and stops it for minutes at a time; this one
   * answers "should it yield right now" (a query is waiting) and stops it for milliseconds.
   * One mechanism serving both questions would make a paused-for-battery backfill and a
   * yielded one indistinguishable in every log line and every test.
   *
   * Per ITEM, not per batch — the opposite of `backfillGate` — because the wait a query
   * cares about is one item's remaining inference, not one page of fifty.
   *
   * Absent (the default) means never yield, which is what every caller that predates this
   * option gets, including both non-worker construction sites.
   */
  priorityGate?: EmbeddingPriorityGate;
```

Add the private field and assign it in the constructor beside `this.backfillGate`:

```typescript
  private readonly priorityGate: EmbeddingPriorityGate | undefined;
  // in constructor:
  this.priorityGate = options.priorityGate;
```

Replace `embedBatch`:

```typescript
  private async embedBatch(rows: readonly IndexedItem[], reportOne: () => void): Promise<void> {
    await mapWithConcurrency(rows, this.backfillConcurrency, async (row) => {
      const release = await this.priorityGate?.acquireBackground();
      try {
        await this.embedItem(row);
      } catch (err) {
        this.logger?.warn({ err, itemId: row.id }, "embedding backfill item failed");
      } finally {
        release?.();
      }
      reportOne();
    });
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/embedding/pipeline.test.ts`
Expected: PASS, including the three new tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/embedding/pipeline.ts packages/gateway/src/embedding/pipeline.test.ts
git commit -m "feat(embedding): gate backfill items on a background permit"
```

---

## Task 4: Wire the gate into the worker core

Covers **both** background producers. `embed_item` is the one that is easy to miss and the one that outlives the backfill: `scheduleItemEmbedding` fires from `index/item-store.ts` on every item upsert, so a long sync keeps one inference slot occupied indefinitely, long after `backfillAll` has finished.

**Files:**

- Modify: `packages/gateway/src/embedding/embedding-worker-core.ts`
- Modify: `packages/gateway/src/embedding/embedding-worker.ts`
- Test: `packages/gateway/src/embedding/embedding-worker-core.test.ts` (existing file — append)

**Interfaces:**

- Consumes: `AsyncPriorityGate` (Task 2), `SqliteEmbeddingPipelineOptions.priorityGate` (Task 3).
- Produces: `EmbeddingWorkerDeps.priorityGate?: EmbeddingPriorityGate` (test seam) and `EmbeddingWorkerSetup` receiving the gate as a second argument, so the production `setup` can hand it to the pipeline it builds.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/embedding/embedding-worker-core.test.ts`, reusing the file's `makeDb`, `INIT_MSG` and `makePipeline` helpers.

```typescript
describe("interactive priority", () => {
  it("acquires an interactive permit around embed_texts", async () => {
    const calls: string[] = [];
    const gate = {
      acquireBackground: async () => () => {},
      acquireInteractive: async () => {
        calls.push("acquire");
        return () => {
          calls.push("release");
        };
      },
    };
    const core = makeCore({ gate, pipeline: makePipeline() });

    core.handleMessage(INIT_MSG);
    await core.idle();
    core.handleMessage({ type: "embed_texts", id: "q1", texts: ["hello"] } satisfies InMsg);
    await core.idle();

    expect(calls).toEqual(["acquire", "release"]);
  });

  it("releases the interactive permit when the embed throws", async () => {
    let released = 0;
    const gate = {
      acquireBackground: async () => () => {},
      acquireInteractive: async () => () => {
        released += 1;
      },
    };
    const core = makeCore({
      gate,
      pipeline: makePipeline({ embedTexts: () => Promise.reject(new Error("boom")) }),
    });

    core.handleMessage(INIT_MSG);
    await core.idle();
    core.handleMessage({ type: "embed_texts", id: "q1", texts: ["hello"] } satisfies InMsg);
    await core.idle();

    // A leaked interactive permit suppresses ALL background embedding for the life of
    // the worker — strictly worse than the starvation this whole change removes.
    expect(released).toBe(1);
  });

  it("acquires a BACKGROUND permit for embed_item, not an interactive one", async () => {
    const kinds: string[] = [];
    const gate = {
      acquireBackground: async () => {
        kinds.push("background");
        return () => {};
      },
      acquireInteractive: async () => {
        kinds.push("interactive");
        return () => {};
      },
    };
    const db = makeDb();
    db.run("INSERT INTO item (id, service, type, title, body_preview) VALUES ('i1','github','issue','T','B')");
    const core = makeCore({ gate, pipeline: makePipeline(), db });

    core.handleMessage(INIT_MSG);
    await core.idle();
    core.handleMessage({ type: "embed_item", itemId: "i1" } satisfies InMsg);
    await core.idle();

    // The sync queue is background work. Classifying it interactive would make a long
    // sync permanently suppress the backfill instead of yielding to real queries.
    expect(kinds).toEqual(["background"]);
  });
});
```

Add the `makeCore` helper near the file's other helpers if one does not already exist:

```typescript
function makeCore(opts: {
  gate?: EmbeddingPriorityGate;
  pipeline: EmbeddingWorkerPipeline;
  db?: Database;
}): EmbeddingWorkerCore {
  const db = opts.db ?? makeDb();
  const setup: EmbeddingWorkerSetup = async () => ({ db, pipeline: opts.pipeline });
  return new EmbeddingWorkerCore({
    sendToMain: () => {},
    setup,
    ...(opts.gate === undefined ? {} : { priorityGate: opts.gate }),
  });
}
```

> The spread-or-omit shape is required by `exactOptionalPropertyTypes`: `{ priorityGate: undefined }` is a type error.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/embedding/embedding-worker-core.test.ts`
Expected: FAIL — `priorityGate` is not a known dep, and `kinds` / `calls` are empty.

- [ ] **Step 3: Implement in the core**

In `embedding-worker-core.ts`, import the gate and extend the deps:

```typescript
import { AsyncPriorityGate, type EmbeddingPriorityGate } from "./priority-gate.ts";
```

```typescript
export type EmbeddingWorkerDeps = {
  sendToMain: (data: unknown) => void;
  setup: EmbeddingWorkerSetup;
  /**
   * Test seam. Production omits it and the core builds its own, so there is exactly one
   * gate per worker and nothing outside the worker realm can hold a reference to it.
   */
  priorityGate?: EmbeddingPriorityGate;
};
```

Widen the setup type so the production builder can pass the gate to the pipeline it constructs:

```typescript
export type EmbeddingWorkerSetup = (
  msg: InitMsg,
  priorityGate: EmbeddingPriorityGate,
) => Promise<{ db: EmbeddingWorkerDb; pipeline: EmbeddingWorkerPipeline }>;
```

Add the field and construct the default:

```typescript
  private readonly priorityGate: EmbeddingPriorityGate;

  constructor(deps: EmbeddingWorkerDeps) {
    this.sendToMain = deps.sendToMain;
    this.setup = deps.setup;
    // DEFAULT_BACKFILL_CONCURRENCY's twin. The gate caps the same population the
    // pipeline's own `mapWithConcurrency` caps, so the two must agree or the tighter
    // one silently wins and the looser number becomes a lie in the config docs.
    this.priorityGate = deps.priorityGate ?? new AsyncPriorityGate(BACKGROUND_PERMITS);
  }
```

Add the constant near the top of the file:

```typescript
/** Matches `DEFAULT_BACKFILL_CONCURRENCY` in `pipeline.ts`. */
const BACKGROUND_PERMITS = 8;
```

Pass the gate through `runInit`:

```typescript
      const { db, pipeline } = await this.setup(msg, this.priorityGate);
```

Wrap `embed_texts` — the interactive path:

```typescript
    if (msg.type === "embed_texts") {
      const pipeline = this.pipeline;
      const { id, texts } = msg;
      this.track(this.runEmbedTexts(pipeline, id, texts));
      return;
    }
```

```typescript
  private async runEmbedTexts(
    pipeline: EmbeddingWorkerPipeline,
    id: string,
    texts: string[],
  ): Promise<void> {
    const release = await this.priorityGate.acquireInteractive();
    try {
      const vectors = await pipeline.embedTexts(texts);
      this.sendToMain({ type: "embed_texts_result", id, ok: true, vectors: vectors.map((v) => Array.from(v)) });
    } catch (err) {
      this.sendToMain({ type: "embed_texts_result", id, ok: false, error: errMessage(err) });
    } finally {
      // A leaked interactive permit suppresses ALL background embedding for the life
      // of the worker, so this `finally` is load-bearing, not defensive.
      release();
    }
  }
```

> **The error key is `error`, not `message`.** An earlier draft of this plan wrote `message` here,
> which would have broken `embedding-worker-core.test.ts`'s existing assertion
> (`{ …, ok: false, error: "embed boom" }`) and any bridge-side reader. Preserve the
> `embed_texts_result` payload shape byte for byte — `ok`, `vectors`, `error` — and copy it from
> the current implementation rather than retyping it from this plan.

Wrap `embed_item` — the background path — inside the existing chain:

```typescript
      this.embedChain = this.embedChain
        .then(async () => {
          const row = conn
            .query("SELECT id, service, type, title, body_preview FROM item WHERE id = ?")
            .get(itemId) as IndexedItem | null | undefined;
          if (row === null || row === undefined) {
            return;
          }
          const release = await this.priorityGate.acquireBackground();
          try {
            await pipeline.embedItem(row);
          } finally {
            release();
          }
        })
        .catch(() => {
          /* unchanged: silent best-effort, see the note below */
        });
```

> The `.catch(() => {})` stays silent and un-logged. That is not an oversight — the existing comment there records it as deliberate behaviour preservation, and adding logging is a separate change with its own justification.

- [ ] **Step 4: Update the production setup**

In `packages/gateway/src/embedding/embedding-worker.ts`, the `setup` function now receives the gate as its second parameter; pass it into the pipeline it builds:

```typescript
const setup: EmbeddingWorkerSetup = async (msg, priorityGate) => {
  // …existing db/embedder construction, unchanged…
  const pipeline = new SqliteEmbeddingPipeline({
    db,
    embedder,
    backfillBatchSize: msg.toml.backfillBatchSize,
    chunkOptions: { /* …existing… */ },
    priorityGate,
    // …existing backfillGate wiring, unchanged…
  });
  return { db, pipeline };
};
```

- [ ] **Step 5: Run the whole embedding suite**

Run: `bun test packages/gateway/src/embedding`
Expected: PASS. Existing `setup` fakes that declare one parameter still satisfy the two-parameter type — TypeScript allows a function of fewer parameters where more are supplied — so no existing test needs editing. If any does fail to typecheck, fix the test rather than widening the production type.

- [ ] **Step 6: Verify the fix against the harness**

Run: `NIMBUS_RUN_EMBED_HARNESS=1 bun test packages/gateway/test/integration/embedding/query-under-backfill.harness.test.ts`
Expected: the harness now **FAILS** its `toBeGreaterThan(idleMs * 2)` assertion, because the gap it was written to prove has closed.

Invert that assertion to `expect(underLoadMs).toBeLessThan(idleMs * 3)` and update the surrounding comment to say it is now a regression guard rather than a defect demonstration. Record the before/after figures in the PR body.

- [ ] **Step 7: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/embedding packages/gateway/test/integration/embedding
git commit -m "feat(embedding): admit interactive queries ahead of background work"
```

---

## PR 2 — Error contract and timeout ordering

## Task 5: The typed timeout error

**Files:**

- Modify: `packages/gateway/src/embedding/embedding-readiness.ts`
- Test: `packages/gateway/src/embedding/embedding-readiness.test.ts` (existing file — append)

**Interfaces:**

- Consumes: `EmbeddingReadiness` (existing).
- Produces: `EmbeddingTimeoutError`, `isEmbeddingTimeoutError`, `EMBEDDING_TIMEOUT_CODE`, `EMBEDDING_TIMEOUT_RPC_CODE` — consumed by Tasks 6, 7 and 9.

- [ ] **Step 1: Write the failing test**

```typescript
describe("EmbeddingTimeoutError", () => {
  const readiness: EmbeddingReadiness = {
    state: "ready",
    elapsedMs: 1_000,
    model: "Xenova/all-MiniLM-L6-v2",
    dims: 384,
    download: null,
    reason: null,
  };

  it("carries the readiness and names the budget", () => {
    const err = new EmbeddingTimeoutError(readiness, 5_000);
    expect(err.readiness.state).toBe("ready");
    expect(err.message).toContain("5000");
    expect(isEmbeddingTimeoutError(err)).toBe(true);
  });

  it("recognises a cross-realm copy by brand, not by instanceof", () => {
    // The runtime crosses a Worker realm; a duplicated module instance defeats
    // `instanceof`, which is why the guard checks the brand. Same reasoning as
    // `isEmbeddingWarmingError`.
    const crossRealm = { code: EMBEDDING_TIMEOUT_CODE, message: "…" };
    expect(isEmbeddingTimeoutError(crossRealm)).toBe(true);
  });

  it("does not confuse a warming error with a timeout", () => {
    const warming = new EmbeddingWarmingError({ ...readiness, state: "warming" });
    expect(isEmbeddingTimeoutError(warming)).toBe(false);
    expect(isEmbeddingWarmingError(warming)).toBe(true);
  });

  it("uses an RPC code distinct from the warming one", () => {
    expect(EMBEDDING_TIMEOUT_RPC_CODE).not.toBe(EMBEDDING_WARMING_RPC_CODE);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/embedding/embedding-readiness.test.ts`
Expected: FAIL — `EmbeddingTimeoutError` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/gateway/src/embedding/embedding-readiness.ts`, directly after the warming error:

```typescript
/** Stable machine-readable code carried by the timeout error and the JSON-RPC error data. */
export const EMBEDDING_TIMEOUT_CODE = "embedding_timeout";

/**
 * JSON-RPC code for "the model is loaded but the query embed did not finish in budget".
 * Distinct from `EMBEDDING_WARMING_RPC_CODE` (-32021) on purpose: warming is a state that
 * ends on its own and justifies "retry shortly", whereas a timeout under contention says
 * nothing about when the next attempt will succeed. Collapsing them would make the CLI's
 * retry advice wrong half the time.
 */
export const EMBEDDING_TIMEOUT_RPC_CODE = -32022;

/**
 * Thrown INSTEAD of resolving `null` when a query embed exceeds its budget.
 *
 * The `null` this replaces was the same false green #928 removed from the warming path,
 * left behind on the timeout path: hybrid search silently loses its vector half and a query
 * with no lexical overlap returns `[]`, which reads as "searched everything, found nothing".
 */
export class EmbeddingTimeoutError extends Error {
  readonly code = EMBEDDING_TIMEOUT_CODE;
  readonly readiness: EmbeddingReadiness;

  constructor(readiness: EmbeddingReadiness, timeoutMs: number) {
    super(
      `the embedding runtime did not answer within ${String(timeoutMs)}ms — the machine is ` +
        `busy indexing. Showing keyword-only matches; semantic ranking will return once ` +
        `indexing settles.`,
    );
    this.name = "EmbeddingTimeoutError";
    this.readiness = readiness;
  }
}

/** Brand check, for the same cross-realm reason as {@link isEmbeddingWarmingError}. */
export function isEmbeddingTimeoutError(err: unknown): err is EmbeddingTimeoutError {
  if (err instanceof EmbeddingTimeoutError) {
    return true;
  }
  if (typeof err !== "object" || err === null) {
    return false;
  }
  return (err as { code?: unknown }).code === EMBEDDING_TIMEOUT_CODE;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/embedding/embedding-readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/embedding/embedding-readiness.ts packages/gateway/src/embedding/embedding-readiness.test.ts
git commit -m "feat(embedding): add a typed query-timeout error"
```

---

## Task 6: Throw the timeout, and order the budgets

**Files:**

- Modify: `packages/gateway/src/embedding/worker-bridge.ts`
- Test: `packages/gateway/src/embedding/worker-bridge.test.ts` (existing file — append)

**Interfaces:**

- Consumes: `EmbeddingTimeoutError` (Task 5).
- Produces: `resolveEmbeddingQueryTimeoutMs(): number` (module-private) and the new throwing behaviour of `embedQuery`, relied on by Task 7.

- [ ] **Step 1: Write the failing test**

```typescript
describe("query timeout", () => {
  // 25ms, not the 5s default. The fake worker below never answers, so the test waits out
  // the whole budget in real time — at the default that is a 5-second stall added to every
  // run of the suite. Restore the previous value in `finally` so the ordering assertion
  // below still measures the real default.
  const BUDGET_ENV = "NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS";

  test("throws EmbeddingTimeoutError instead of resolving null", async () => {
    const prev = process.env[BUDGET_ENV];
    process.env[BUDGET_ENV] = "25";
    try {
      installFakeWorker();
      const bridge = makeBridge();
      // The fake worker records postMessage and answers nothing, which is exactly the
      // starved-worker case: `embed_texts` goes out, no `embed_texts_result` comes back.
      currentHandle().fire({ type: "ready" });

      const promise = bridge.embedQuery("anything");
      await expect(promise).rejects.toThrow(/did not answer within/);
      await promise.catch((err: unknown) => {
        expect(isEmbeddingTimeoutError(err)).toBe(true);
      });
    } finally {
      if (prev === undefined) {
        Reflect.deleteProperty(process.env, BUDGET_ENV);
      } else {
        process.env[BUDGET_ENV] = prev;
      }
    }
  });

  test("defaults the budget well below the CLI's 30s transport bound", () => {
    // The ordering IS the fix. At the previous 60s the inner bound was unreachable and
    // the user saw a transport error instead of a disclosed degradation.
    expect(resolveEmbeddingQueryTimeoutMs()).toBeLessThan(30_000);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/embedding/worker-bridge.test.ts`
Expected: FAIL — the promise resolves `null` rather than rejecting.

- [ ] **Step 3: Implement**

Add the resolver beside the existing `resolveEmbeddingInitTimeoutMs`, mirroring its shape exactly:

```typescript
/**
 * 5s, not 60s. The bound must sit well under the CLI's 30s transport timeout, or the
 * transport error wins the race and the user sees `IPC request timed out` instead of a
 * disclosed keyword-only result. 5s also leaves room for one in-flight background item
 * to finish on a slow machine, which is the wait the priority gate reduces this to.
 */
const DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS = 5_000;

export function resolveEmbeddingQueryTimeoutMs(): number {
  const raw = processEnvGet("NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS");
  if (raw === undefined) {
    return DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS;
  }
  return n;
}
```

Replace the timeout arm of `embedQuery`. The `pending` map's `resolve` must become a settler that can reject, so change the `Pending` type to carry both:

```typescript
type Pending = {
  resolve: (v: Float32Array | null) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
```

```typescript
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!this.workerReady) {
      const readiness = this.getReadiness();
      if (readiness.state === "warming") {
        throw new EmbeddingWarmingError(readiness);
      }
      return null;
    }
    const id = randomUUID();
    const budgetMs = resolveEmbeddingQueryTimeoutMs();
    return new Promise<Float32Array | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EmbeddingTimeoutError(this.getReadiness(), budgetMs));
      }, budgetMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: "embed_texts", id, texts: [text] });
    });
  }
```

> The trailing `.catch(...)` that logged and returned `null` is **removed**. It was the thing converting every failure into the false green; leaving it would swallow the error this task exists to raise.

Update `terminate()`, which currently resolves every pending caller with `null`. That is still correct — a torn-down bridge is a permanent absence, not a timeout — but it must clear the new field shape:

```typescript
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(null);
    }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/embedding/worker-bridge.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole embedding suite for fallout**

Run: `bun test packages/gateway/src/embedding`
Expected: PASS. Any test asserting `embedQuery` resolves `null` on timeout is now asserting the old defect — update it to expect the throw.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/embedding/worker-bridge.ts packages/gateway/src/embedding/worker-bridge.test.ts
git commit -m "fix(embedding): throw on query-embed timeout instead of a null vector"
```

---

## Task 7: Report what the best-effort wrappers swallow

**Files:**

- Modify: `packages/gateway/src/embedding/embedding-readiness.ts`
- Test: `packages/gateway/src/embedding/embedding-readiness.test.ts` (append)

**Interfaces:**

- Consumes: `isEmbeddingTimeoutError` (Task 5).
- Produces: `UnrankedReason`, `ReportedDualVectors`, `embedQueryDualBestEffortReported(rt, text)` — consumed by Tasks 8 and 9.

- [ ] **Step 1: Write the failing test**

```typescript
describe("embedQueryDualBestEffortReported", () => {
  const vectors = { vec384: new Float32Array([1]), vec1536: null, model384: "m", model1536: null };

  it("reports no reason when the embed succeeds", async () => {
    const rt = { embedQueryDual: async () => vectors };
    const out = await embedQueryDualBestEffortReported(rt, "q");
    expect(out.reason).toBeNull();
    expect(out.vectors.vec384).not.toBeNull();
  });

  it("reports 'warming' and empty vectors while warming", async () => {
    const rt = {
      embedQueryDual: () => Promise.reject(new EmbeddingWarmingError(warmingReadiness)),
    };
    const out = await embedQueryDualBestEffortReported(rt, "q");
    expect(out.reason).toBe("warming");
    expect(out.vectors.vec384).toBeNull();
  });

  it("reports 'timeout' distinctly from 'warming'", async () => {
    const rt = {
      embedQueryDual: () => Promise.reject(new EmbeddingTimeoutError(readyReadiness, 5_000)),
    };
    const out = await embedQueryDualBestEffortReported(rt, "q");
    // These must not collapse: warming ends on its own, a timeout does not.
    expect(out.reason).toBe("timeout");
  });

  it("reports 'unavailable' when the runtime hands back a null vector", async () => {
    const rt = {
      embedQueryDual: async () => ({ vec384: null, vec1536: null, model384: null, model1536: null }),
    };
    const out = await embedQueryDualBestEffortReported(rt, "q");
    expect(out.reason).toBe("unavailable");
  });

  it("re-throws an unrelated error rather than reporting it as a degradation", async () => {
    const rt = { embedQueryDual: () => Promise.reject(new Error("disk on fire")) };
    // Swallowing an unknown error would turn a real bug into a quiet "keyword-only" note.
    expect(embedQueryDualBestEffortReported(rt, "q")).rejects.toThrow("disk on fire");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/embedding/embedding-readiness.test.ts`
Expected: FAIL — `embedQueryDualBestEffortReported` is not exported.

- [ ] **Step 3: Implement**

```typescript
/**
 * Why a query was not vector-ranked. Ordered from most transient to most permanent.
 * `null` (the absence of this value) means it WAS vector-ranked.
 */
export type UnrankedReason =
  /** The model is still loading. Ends on its own; retrying later works. */
  | "warming"
  /** The embed exceeded its budget, almost always because the machine is busy indexing. */
  | "timeout"
  /** Init failed for this process. Retrying will not help until the gateway restarts. */
  | "unavailable"
  /** Semantic search was switched off for this query or by config. */
  | "disabled";

export type ReportedDualVectors = {
  readonly vectors: EmbeddingDualVectors;
  readonly reason: UnrankedReason | null;
};

/**
 * {@link embedQueryDualBestEffort} that says WHY it degraded.
 *
 * The plain wrapper returns `NO_DUAL_VECTORS` for warming, for timeout and for a runtime
 * that handed back `null` — three different facts flattened into one indistinguishable
 * value. Search needs them apart to tell the user something true, so this variant keeps
 * the reason instead of discarding it. The plain wrapper stays for callers that ADD
 * optional context and never report "zero results" to a human (session-memory recall,
 * tribal clustering), which genuinely do not care why.
 */
export async function embedQueryDualBestEffortReported(
  rt: EmbedQueryDualLike,
  text: string,
): Promise<ReportedDualVectors> {
  try {
    const vectors = await rt.embedQueryDual(text);
    if (vectors.vec384 === null && vectors.vec1536 === null) {
      return { vectors, reason: "unavailable" };
    }
    return { vectors, reason: null };
  } catch (err) {
    if (isEmbeddingWarmingError(err)) {
      return { vectors: { ...NO_DUAL_VECTORS }, reason: "warming" };
    }
    if (isEmbeddingTimeoutError(err)) {
      return { vectors: { ...NO_DUAL_VECTORS }, reason: "timeout" };
    }
    // Deliberately NOT swallowed: an unknown failure is a bug, and reporting it as a
    // routine degradation is how bugs become permanent.
    throw err;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/embedding/embedding-readiness.test.ts`
Expected: PASS.

- [ ] **Step 5: Preflight and commit**

```bash
bun run preflight:fast
git add packages/gateway/src/embedding/embedding-readiness.ts packages/gateway/src/embedding/embedding-readiness.test.ts
git commit -m "feat(embedding): report the reason a best-effort query embed degraded"
```

---

## PR 3 — Disclosure and consumers

## Task 8: The disclosure type and its constructor

**Files:**

- Create: packages/gateway/src/index/search-disclosure.ts
- Test: packages/gateway/src/index/search-disclosure.test.ts

**Interfaces:**

- Consumes: `UnrankedReason` (Task 7).
- Produces: `SearchRetrievalDisclosure`, `EmbeddingCoverageSummary`, `SearchRankedEnvelope<T>`, `buildRetrievalDisclosure(args)` — consumed by Tasks 9 and 10.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "bun:test";

import { buildRetrievalDisclosure } from "./search-disclosure.ts";

describe("buildRetrievalDisclosure", () => {
  it("reports a vector-ranked query with no reason", () => {
    const d = buildRetrievalDisclosure({ reason: null, backfill: null });
    expect(d.vectorRanked).toBe(true);
    expect(d.unrankedReason).toBeNull();
  });

  it("reports the reason when not vector-ranked", () => {
    const d = buildRetrievalDisclosure({ reason: "timeout", backfill: null });
    expect(d.vectorRanked).toBe(false);
    expect(d.unrankedReason).toBe("timeout");
  });

  it("reports coverage from live backfill progress", () => {
    const d = buildRetrievalDisclosure({ reason: null, backfill: { done: 8_400, total: 60_000 } });
    expect(d.coverage).toEqual({ embeddedItems: 8_400, totalItems: 60_000, percent: 14 });
  });

  it("omits coverage when no backfill is running", () => {
    // Absent, not zero and not a guess: the O(1) counter is the only cheap source, and
    // paying `index health`'s full table scan per query is what this avoids.
    const d = buildRetrievalDisclosure({ reason: null, backfill: null });
    expect(d.coverage).toBeNull();
  });

  it("does not divide by zero on an empty index", () => {
    const d = buildRetrievalDisclosure({ reason: null, backfill: { done: 0, total: 0 } });
    expect(d.coverage?.percent).toBe(100);
  });

  it("rounds percent to one decimal", () => {
    const d = buildRetrievalDisclosure({ reason: null, backfill: { done: 1, total: 3 } });
    expect(d.coverage?.percent).toBe(33.3);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/src/index/search-disclosure.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
import type { UnrankedReason } from "../embedding/embedding-readiness.ts";

/**
 * How much of the index has vectors, as of this query.
 *
 * Deliberately NOT the same number `nimbus index health` reports. That one is the
 * authoritative full computation — a `LEFT JOIN` over `SELECT DISTINCT item_id FROM
 * embedding_chunk` across the whole `item` table — which is correct for a report run on
 * demand and indefensible on the path of every keystroke. This is the O(1) live progress
 * counter the embedding worker already maintains. It can lag, and it does not account for
 * items that failed to embed. Callers that need the real figure run `nimbus index health`.
 */
export type EmbeddingCoverageSummary = {
  readonly embeddedItems: number;
  readonly totalItems: number;
  /** 0-100, one decimal. 100 when the index is empty — nothing is missing. */
  readonly percent: number;
};

export type SearchRetrievalDisclosure = {
  /** True when vector/hybrid scoring ran; false when the results are BM25 only. */
  readonly vectorRanked: boolean;
  /** Why not, when `vectorRanked` is false. Always `null` when it is true. */
  readonly unrankedReason: UnrankedReason | null;
  /** Live coverage, or `null` when no backfill is running and the cheap counter is idle. */
  readonly coverage: EmbeddingCoverageSummary | null;
};

/**
 * Search results plus the disclosure that qualifies them.
 *
 * The two travel together on purpose. A disclosure a caller must remember to fetch
 * separately is one that will eventually go missing — the same reasoning that makes I31
 * construct brief disclosures at the renderer and re-attach them verbatim.
 */
export type SearchRankedEnvelope<T> = {
  readonly items: T[];
  readonly retrieval: SearchRetrievalDisclosure;
};

export type BuildRetrievalDisclosureArgs = {
  readonly reason: UnrankedReason | null;
  readonly backfill: { done: number; total: number } | null;
};

export function buildRetrievalDisclosure(
  args: BuildRetrievalDisclosureArgs,
): SearchRetrievalDisclosure {
  return {
    vectorRanked: args.reason === null,
    unrankedReason: args.reason,
    coverage: args.backfill === null ? null : summarise(args.backfill),
  };
}

function summarise(p: { done: number; total: number }): EmbeddingCoverageSummary {
  const total = Math.max(0, Math.floor(p.total));
  const done = Math.min(Math.max(0, Math.floor(p.done)), total === 0 ? 0 : total);
  // An empty index is fully covered, not zero-covered: there is nothing missing from it.
  const percent = total === 0 ? 100 : Math.round((done / total) * 1000) / 10;
  return { embeddedItems: done, totalItems: total, percent };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test packages/gateway/src/index/search-disclosure.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/index/search-disclosure.ts packages/gateway/src/index/search-disclosure.test.ts
git commit -m "feat(index): add the search retrieval-quality disclosure"
```

---

## Task 9: Return the envelope, and update every in-process caller

`searchRankedAsync` returns the envelope to **all** in-process callers. There are five besides the definition; the typecheck finds them all, but they are listed so nothing is missed when reading tasks out of order.

**Files:**

- Modify: `packages/gateway/src/index/local-index.ts`
- Modify: `packages/gateway/src/platform/assemble.ts`
- Modify: `packages/gateway/src/engine/run-ask.ts` (~line 517)
- Modify: `packages/gateway/src/engine/agent.ts` (~line 230)
- Modify: `packages/gateway/src/briefs/brief-index-search.ts` (~line 17)
- Modify: `packages/gateway/src/toolgen/toolgen-grounding.ts` (~line 77)
- Modify: `packages/gateway/src/ipc/server/inline-handlers.ts` (~line 298)
- Test: packages/gateway/test/integration/index/search-disclosure.integration.test.ts (create)

**Interfaces:**

- Consumes: `SearchRankedEnvelope`, `buildRetrievalDisclosure` (Task 8); `embedQueryDualBestEffortReported`, `ReportedDualVectors` (Task 7).
- Produces: `searchRankedAsync(...): Promise<SearchRankedEnvelope<RankedIndexItem>>`; `SemanticSearchDeps.embedQueryDualReported?`; `LocalIndexOptions.backfillProgress?`. Task 10 consumes the IPC behaviour only.

- [ ] **Step 1: Write the failing integration test**

Real SQLite, real migrations — the `raw_meta` lesson from `nimbus index health` is that a hand-written schema can pass while the live one does not.

```typescript
import { describe, expect, it } from "bun:test";

// Use this suite's existing helper for a migrated temp DB + LocalIndex.
describe("search retrieval disclosure", () => {
  it("reports vectorRanked=false with a reason when the query cannot embed", async () => {
    const index = makeIndexWithSemanticSearch({
      embedQueryDualReported: async () => ({
        vectors: { vec384: null, vec1536: null, model384: null, model1536: null },
        reason: "timeout" as const,
      }),
    });

    const out = await index.searchRankedAsync({ name: "deploy", limit: 5 }, { semantic: true });

    expect(out.retrieval.vectorRanked).toBe(false);
    expect(out.retrieval.unrankedReason).toBe("timeout");
    expect(Array.isArray(out.items)).toBe(true);
  });

  it("reports vectorRanked=true when the query embeds", async () => {
    const index = makeIndexWithSemanticSearch({
      embedQueryDualReported: async () => ({
        vectors: { vec384: new Float32Array(384), vec1536: null, model384: "m", model1536: null },
        reason: null,
      }),
    });

    const out = await index.searchRankedAsync({ name: "deploy", limit: 5 }, { semantic: true });
    expect(out.retrieval.vectorRanked).toBe(true);
  });

  it("reports disabled when the caller opted out of semantic search", async () => {
    const index = makeIndexWithSemanticSearch({});
    const out = await index.searchRankedAsync({ name: "deploy", limit: 5 }, { semantic: false });
    // Not a degradation — the caller asked for keyword-only. Saying "timeout" here
    // would be a lie, and saying nothing would leave `vectorRanked: true` on a BM25 result.
    expect(out.retrieval.vectorRanked).toBe(false);
    expect(out.retrieval.unrankedReason).toBe("disabled");
  });

  it("carries live coverage when a backfill is in progress", async () => {
    const index = makeIndexWithSemanticSearch({ backfillProgress: () => ({ done: 10, total: 40 }) });
    const out = await index.searchRankedAsync({ name: "deploy", limit: 5 }, { semantic: false });
    expect(out.retrieval.coverage?.percent).toBe(25);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/gateway/test/integration/index/search-disclosure.integration.test.ts`
Expected: FAIL — `out.retrieval` is undefined (the method still returns an array).

- [ ] **Step 3: Extend the seams in `local-index.ts`**

```typescript
export type SemanticSearchDeps = {
  model: string;
  embedQuery: (text: string) => Promise<Float32Array | null>;
  embedQueryDual: (text: string) => Promise<{
    vec384: Float32Array | null;
    vec1536: Float32Array | null;
    model384: string | null;
    model1536: string | null;
  }>;
  /**
   * The reporting variant. OPTIONAL so every existing construction site — production and
   * the many tests that build a `SemanticSearchDeps` by hand — keeps compiling; when it is
   * absent the disclosure reports `vectorRanked` from the vectors alone and cannot say why.
   */
  embedQueryDualReported?: (text: string) => Promise<ReportedDualVectors>;
};

export type LocalIndexOptions = {
  scheduleItemEmbedding?: (itemId: string) => void;
  semanticSearch?: SemanticSearchDeps;
  /** O(1) live backfill progress, for the coverage half of the disclosure. */
  backfillProgress?: () => { done: number; total: number } | null;
};
```

- [ ] **Step 4: Rewrite `searchRankedAsync` to return the envelope**

Keep the existing hybrid body; change only the return shape and add the reason capture. The two `return` statements become envelope constructions:

```typescript
  async searchRankedAsync(
    query: IndexSearchQuery,
    options?: SearchRankOptions & { semantic?: boolean; contextChunks?: number },
  ): Promise<SearchRankedEnvelope<RankedIndexItem>> {
    const nameQ = query.name?.trim() ?? "";
    const semanticOn = options?.semantic ?? true;
    const ss = this.semanticSearch;
    const uv = readIndexedUserVersion(this.db);
    const vecReady = ensureSqliteVecForConnection(this.db, uv);
    const canHybrid = semanticOn && nameQ !== "" && ss !== undefined && uv >= 6 && vecReady;
    const backfill = this.options?.backfillProgress?.() ?? null;

    if (canHybrid) {
      const t0 = performance.now();
      try {
        // The reporting variant when wired; otherwise fall back and infer the reason
        // from the vectors, which can distinguish "no vectors" but not why.
        const reported: ReportedDualVectors = ss.embedQueryDualReported
          ? await ss.embedQueryDualReported(nameQ)
          : await inferFromPlain(ss, nameQ);
        const dual = reported.vectors;

        // …existing hybridSearch call and result mapping, unchanged…

        return {
          items: mapped,
          retrieval: buildRetrievalDisclosure({ reason: reported.reason, backfill }),
        };
      } finally {
        this.emitQueryLatency("hybrid", performance.now() - t0, nameQ.slice(0, 200) || null);
      }
    }

    return {
      items: this.searchRanked(query, options),
      retrieval: buildRetrievalDisclosure({ reason: "disabled", backfill }),
    };
  }
```

Add the fallback helper at module scope:

```typescript
/** Best available reason when only the non-reporting seam is wired. */
async function inferFromPlain(
  ss: SemanticSearchDeps,
  text: string,
): Promise<ReportedDualVectors> {
  const vectors = await ss.embedQueryDual(text);
  const empty = vectors.vec384 === null && vectors.vec1536 === null;
  return { vectors, reason: empty ? "unavailable" : null };
}
```

> The non-hybrid path reports `"disabled"` because that branch is reached when the caller passed `semantic: false`, the query was empty, or vec is unavailable — none of which is a degradation under load. It must not report `vectorRanked: true`: these ARE keyword-only results.

- [ ] **Step 5: Wire the new seams in `assemble.ts`**

At the `semanticSearch` construction (~line 464):

```typescript
    semanticSearch = {
      model: rt.getEmbeddingModel(),
      embedQuery: (text: string) => embedQueryBestEffort(rt, text),
      embedQueryDual: (text: string) => embedQueryDualBestEffort(rt, text),
      embedQueryDualReported: (text: string) => embedQueryDualBestEffortReported(rt, text),
    };
```

And add the progress seam where `localIndexOpts` is built:

```typescript
  if (rt !== undefined) {
    localIndexOpts.backfillProgress = () => rt.getBackfillProgress();
  }
```

- [ ] **Step 6: Update the four internal callers**

Each reads `.items`. Exact edits:

`packages/gateway/src/engine/run-ask.ts` — `primary` is used for both `.length` and `.slice`, so name the envelope and take items once:

```typescript
    const primaryResult = await localIndex.searchRankedAsync(
      { name: searchTerms, limit: LOCAL_CONTEXT_TOTAL_PROBE_LIMIT },
      { semantic: true, contextChunks: 2 },
    );
    const primary = primaryResult.items;
```

`packages/gateway/src/engine/agent.ts`:

```typescript
      const ranked = (
        await deps.localIndex.searchRankedAsync(query, {
          searchServicePriority: searchPriority,
          semantic,
          contextChunks,
        })
      ).items;
```

`packages/gateway/src/briefs/brief-index-search.ts`:

```typescript
    const hits = (
      await localIndex.searchRankedAsync({ name: query, limit }, { semantic: true, contextChunks: 2 })
    ).items;
```

`packages/gateway/src/toolgen/toolgen-grounding.ts`:

```typescript
      items = (await index.searchRankedAsync({ itemType: "api_endpoint", name: query, limit })).items;
```

- [ ] **Step 7: Unwrap at the IPC boundary**

In `packages/gateway/src/ipc/server/inline-handlers.ts`, replace the final return of `rpcSearchRanked`:

```typescript
  const result = await ctx.options.localIndex.searchRankedAsync(query, {
    semantic,
    contextChunks,
  });
  // The published `@nimbus-dev/client` runs this response through a validator whose first
  // act asserts it is an array, so an unconditional envelope would THROW on every call in
  // the VS Code extension and any third-party consumer — not merely mistype. Opt-in only.
  return rec["envelope"] === true ? result : result.items;
```

- [ ] **Step 8: Update the test mocks that return a bare array**

Several existing tests replace `searchRankedAsync` with one returning `[]`. They must return an
envelope instead. **The typecheck finds some of them and not others**, which is the trap: the
assignments in `run-ask.test.ts` are typed and fail compilation, but `agent.test.ts` goes through
`as unknown as { searchRankedAsync: … }` casts, and a cast silences exactly the error that would
have found it. Those surface only as a runtime `TypeError` on `.items` of `undefined`.

So find them by grep, not by the compiler:

```bash
grep -rn "searchRankedAsync" packages/gateway/src --include=*.test.ts
```

Known sites at the time of writing — re-derive rather than trusting this list:
`packages/gateway/src/engine/run-ask.test.ts` (four assignments), and
`packages/gateway/src/engine/agent.test.ts` (two, both behind casts).

Each becomes an envelope:

```typescript
localIndex.searchRankedAsync = async () => ({
  items: [],
  retrieval: { vectorRanked: false, unrankedReason: "disabled", coverage: null },
});
```

**Do NOT make the production callers defensive instead.** Accepting either shape
(`Array.isArray(res) ? res : res.items`) in `run-ask.ts` or `agent.ts` would make the old mocks
pass untouched, and it is the wrong trade three times over: the array branch is unreachable in
production, since `searchRankedAsync` always returns an envelope; it shapes shipping code around
test fixtures; and it destroys the very property this task relies on, that a type change surfaces
every caller. A mock that lies about its subject's shape is a defect in the mock.

- [ ] **Step 9: Run the tests**

Run: `bun test packages/gateway/test/integration/index/search-disclosure.integration.test.ts`
Expected: PASS, 4 tests.

Run: `bun run typecheck`
Expected: clean. A red typecheck here is the mechanism that proves every PRODUCTION caller was
found — do not silence one with a cast.

Run: `bun test packages/gateway/src packages/gateway/test`
Expected: PASS. A `TypeError` reading `.items` of `undefined` means Step 8 missed a cast-hidden
mock.

- [ ] **Step 10: Commit**

```bash
bun run preflight:fast
git add packages/gateway/src packages/gateway/test
git commit -m "feat(index): return search results with a retrieval-quality disclosure"
```

---

## Task 10: Surface the disclosure in the CLI and MCP

**Files:**

- Modify: `packages/cli/src/commands/search.ts`
- Modify: `packages/cli/src/mcp/adapter.ts` (~line 348)
- Test: `packages/cli/src/commands/search.test.ts` (existing file — append)

**Interfaces:**

- Consumes: the `envelope: true` IPC parameter (Task 9).
- Produces: nothing downstream. Final task.

- [ ] **Step 1: Write the failing test**

```typescript
// Harness note: this file already imports `setFixture` / `clearFixture` / `FAKE_SOCKET_PATH`
// from `../../test/helpers/cli-mocks.ts`, `captureOutput` from `../../test/helpers/cli-output.ts`
// (as the module-level `out`), and `createMockIpcClient` from
// `../../test/helpers/mock-ipc-client.ts`. Reuse them. `out.stdout` and `out.stderr` are GETTER
// PROPERTIES, not methods — `out.stdout()` throws.

function envelope(retrieval: unknown, items: unknown[] = [{ id: "github:pr_1", name: "My PR" }]) {
  return { items, retrieval };
}

describe("runSearch — retrieval disclosure", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("keeps stdout a bare JSON array so `| jq '.[0]'` still works", async () => {
    const mock = createMockIpcClient([
      envelope({ vectorRanked: false, unrankedReason: "timeout", coverage: null }),
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    const parsed: unknown = JSON.parse(out.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(out.stdout).not.toContain("retrieval");
  });

  it("writes the degradation note to stderr", async () => {
    const mock = createMockIpcClient([
      envelope({ vectorRanked: false, unrankedReason: "timeout", coverage: null }, []),
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    expect(out.stderr).toContain("keyword-only");
  });

  it("writes a coverage note to stderr when the index is partial", async () => {
    const mock = createMockIpcClient([
      envelope(
        {
          vectorRanked: true,
          unrankedReason: null,
          coverage: { embeddedItems: 8_400, totalItems: 60_000, percent: 14 },
        },
        [],
      ),
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    expect(out.stderr).toContain("8,400");
    expect(out.stderr).toContain("60,000");
  });

  it("says nothing on stderr for a fully-ranked, fully-covered query", async () => {
    const mock = createMockIpcClient([
      envelope({ vectorRanked: true, unrankedReason: null, coverage: null }),
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    // Noise on every healthy search trains people to ignore the channel entirely.
    expect(out.stderr).toBe("");
  });

  it("still prints results when an OLDER gateway ignores `envelope` and returns an array", async () => {
    // Not a test-fixture concession: `nimbus` talks to a RUNNING gateway process, so an
    // upgraded CLI can meet a gateway that predates Task 9 and answers with a bare array.
    const mock = createMockIpcClient([[{ id: "github:pr_1", name: "My PR" }]]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    const parsed: unknown = JSON.parse(out.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(out.stderr).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test packages/cli/src/commands/search.test.ts`
Expected: FAIL — stdout contains the whole envelope.

- [ ] **Step 3: Implement in `search.ts`**

`searchWithWarmingFallback` currently returns `unknown[]`. Widen it to
`unknown[] | { items: unknown[]; retrieval?: RetrievalNote }`, add `envelope: true` to both of
its `client.call` invocations (the fallback call included — a warming retry must disclose too),
and print:

```typescript
    const raw = await searchWithWarmingFallback(client, { ...params, envelope: true }, semantic);
    // Accept BOTH shapes. Not for the tests' benefit — for version skew: `nimbus` connects to a
    // RUNNING gateway process, so an upgraded CLI can meet an older gateway that has never heard
    // of `envelope` and answers with a bare array. Crashing there would make a CLI upgrade look
    // like a broken install. This is the one place the tolerance is earned; the gateway-internal
    // callers in Task 9 are in-process and must NOT do this.
    const items = Array.isArray(raw) ? raw : raw.items;
    const retrieval = Array.isArray(raw) ? undefined : raw.retrieval;

    // stdout stays a bare array. This command is documented as pipeable
    // (`nimbus search q | jq '.[0]'`), and the existing warming note two functions below
    // already established stderr as the channel for anything that is not the result.
    console.log(JSON.stringify(items, null, 2));
    printRetrievalNotes(retrieval);
```

```typescript
type RetrievalNote = {
  vectorRanked: boolean;
  unrankedReason: string | null;
  coverage: { embeddedItems: number; totalItems: number; percent: number } | null;
};

/** Notes go to stderr; a healthy query prints nothing at all. */
function printRetrievalNotes(r: RetrievalNote | undefined): void {
  if (r === undefined) {
    return;
  }
  if (!r.vectorRanked && r.unrankedReason !== null && r.unrankedReason !== "disabled") {
    console.error(
      `note: semantic ranking unavailable (${r.unrankedReason}) — showing keyword-only results.`,
    );
  }
  if (r.coverage !== null && r.coverage.percent < 100) {
    const n = (v: number) => v.toLocaleString("en-US");
    console.error(
      `note: embedding coverage ${n(r.coverage.embeddedItems)}/${n(r.coverage.totalItems)} items ` +
        `(${String(r.coverage.percent)}%). Run 'nimbus index health' for detail.`,
    );
  }
}
```

> `"disabled"` prints nothing: the user passed `--no-semantic`, and telling them their own flag took effect is noise.

- [ ] **Step 4: Implement in the MCP adapter**

At `packages/cli/src/mcp/adapter.ts` (~line 348), pass the flag and carry the disclosure into the tool result so the calling model sees it:

```typescript
  const raw = await client.call<unknown>("index.searchRanked", { ...params, envelope: true });
```

Then unwrap `items` for the existing row mapping and include the disclosure in the tool's structured output alongside the rows, so it rides `wrapToolOutput` (I11) with everything else. Follow the adapter's existing result-shaping helper rather than adding a second one.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/cli/src`
Expected: PASS. This is the combined run where `mock.module` contamination shows up; if a failure appears only here and not in a scoped run, prefer dependency injection over `mock.module` in the new test.

- [ ] **Step 6: Full preflight**

```bash
bun run preflight
```

Expected: PASS. Run `bun run verify:docker --changed` as well if any test behaves differently on Linux.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src
git commit -m "feat(cli): disclose degraded or partial retrieval on stderr"
```

---

## Task 11: Strip the design documents and open the PR

**Files:**

- Delete: `docs/superpowers/specs/2026-09-12-cold-start-search-starvation-design.md`
- Delete: `docs/superpowers/specs/2026-09-12-cold-start-search-starvation-review.md`
- Delete: `docs/superpowers/plans/2026-09-12-cold-start-search-starvation.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Move the durable content into `docs/architecture.md`**

Add a subsection to the embedding/index area covering: the two background producers and why both are gated; why the priority gate is separate from `BackfillGate`; why interactive admission does not wait for a full drain; the timeout ordering (5 s inner vs 30 s CLI) and why the inner bound must be tighter; why the search-time coverage figure differs from `nimbus index health`'s and which is authoritative; and why the IPC envelope is opt-in (the published client's array validator).

Rejected alternatives worth keeping: the sidecar-accessor disclosure, refusing instead of degrading, throttling the backfill on host idleness, and breaking the wire contract.

- [ ] **Step 2: Delete the three documents**

```bash
git rm docs/superpowers/specs/2026-09-12-cold-start-search-starvation-design.md \
       docs/superpowers/specs/2026-09-12-cold-start-search-starvation-review.md \
       docs/superpowers/plans/2026-09-12-cold-start-search-starvation.md
```

- [ ] **Step 3: Verify nothing spec-shaped remains in the diff**

```bash
git diff origin/main...HEAD --stat -- docs/superpowers/
```

Expected: **empty**. Squash takes the net tree diff, so an add-then-delete on this branch lands nothing on `main`.

- [ ] **Step 4: Full preflight**

```bash
bun run preflight
```

Expected: PASS, including `audit:doc-refs` — `docs/superpowers` is scanned since the 2026-09-11 prune dropped it from `DOCS_EXCLUDED_PREFIXES`, so a dangling reference to a deleted spec fails the gate.

- [ ] **Step 5: Commit, push, open the PR**

The PR title is the conventional-commit subject release-please parses, and the PR body becomes the permanent commit message. Keep parentheses balanced in the body — an unbalanced `(` drops the commit from release-please.

Report the harness numbers from Task 1 Step 3 and Task 4 Step 6 in the body.

```bash
git add docs/architecture.md
git commit -m "docs(architecture): record the cold-start retrieval design"
git push -u origin dev/asafgolombek/cold-start-search
gh pr create --base main --title "fix(embedding): stop cold-start search from starving behind the backfill"
```

Then monitor CI to green.

---

## Self-Review

**Spec coverage.** §2.1 → Tasks 2–4 · §2.2 → Task 6 · §2.3 → Tasks 5–6 · §2.4 → Task 8 (coverage) + Task 9 (`disabled`/reason plumbing) · §2.5 → Task 9 Step 4 · §4.1 → Tasks 2–4, including the `embed_item` clause (Task 4 Step 1, third test) and the no-full-drain clause (Task 2 Step 1, second test, red-proved at Step 5) · §4.2 → Tasks 5–7 · §4.3 → Task 8, with the O(1)-counter decision in the constructor's docblock and the "coverage absent when idle" case tested · §4.4 → Task 9 Step 7 · §4.5 → Task 9 Step 6 (all four internal callers, `toolgen-grounding.ts` included) and Task 10 (CLI + MCP) · §5 rejected alternatives → Task 11 Step 1 · §6 → Task 1 (measurement), Task 2 Step 5 (red-prove by reverting), Task 3 (error-path permit release), Task 5 (typed throw, not truthiness) · §7 → Task 1 Step 3 resolves the ONNX residual; deferrals are simply not implemented · §8 → the three PR groupings, with Task 11 enforcing the strip.

**Placeholders.** None now — but this section claimed that once already and was wrong, so the
correction is recorded rather than quietly applied. A 2026-09-12 review of this plan found that
Tasks 3, 6 and 10 cited test helpers that **do not exist**: `makeSeededDb` / `makeFakeEmbedder` /
`embeddedCount` (the real ones are `freshDb` / `mockEmbedder`), `makeSilentWorker` /
`makeReadyBridge` (`installFakeWorker` / `makeBridge` / `currentHandle`), and `fakeClient` /
`runSearchCapturingOutput` (`setFixture` / `createMockIpcClient` / `captureOutput`). Task 6 also
called an `advanceBeyondQueryBudget()` that was never defined anywhere. All are corrected against
the real files.

The class is worth naming because it recurs: **a plausible name written from memory reads exactly
like a verified one.** It is the same defect as the spec's original §4.5, which listed capabilities
that looked like an enumeration of call sites and named no file. The rule both times is the same —
open the file and copy the identifier, never infer it.

**Type consistency.** `EmbeddingPriorityGate` / `acquireBackground` / `acquireInteractive` identical across Tasks 2–4 · `priorityGate` is the option name in both `SqliteEmbeddingPipelineOptions` and `EmbeddingWorkerDeps` · `UnrankedReason` defined once in Task 7 and consumed unchanged by Task 8 · `ReportedDualVectors` produced in Task 7, consumed in Task 9 · `SearchRankedEnvelope<T>` produced in Task 8, used as `SearchRankedEnvelope<RankedIndexItem>` in Task 9 · `buildRetrievalDisclosure({ reason, backfill })` called with exactly those keys everywhere.

**One gap accepted deliberately:** Task 4 Step 3 changes `EmbeddingWorkerSetup`'s arity, which the plan claims existing one-parameter test fakes satisfy. That is true in TypeScript but is asserted rather than demonstrated; Task 4 Step 5 verifies it by running the suite, and says what to do if it does not hold.
