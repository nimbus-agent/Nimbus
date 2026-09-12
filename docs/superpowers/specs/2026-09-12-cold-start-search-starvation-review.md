# Cold-Start Search Starvation — Spec Review & Improvements

**Date:** 2026-09-12 · **Review Target:** [`2026-09-12-cold-start-search-starvation-design.md`](./2026-09-12-cold-start-search-starvation-design.md) · **Status:** Complete Review

---

## 1. Executive Summary & Verdict

The design correctly diagnoses the root cause of the Windows ONNX verification failure recorded on issue #1396: **unbounded contention between background backfill and interactive query embedding sharing a single worker without admission control, exacerbated by inverted timeout thresholds and silent false-green degradation.**

The core architectural direction—**in-worker admission control with priority preemption, tight fail-fast inner timeout throwing a typed error, single-site disclosure construction, and opt-in wire-compatible IPC envelopes**—is sound and aligns with Nimbus non-negotiables (local-first, platform equality, no silent data masking).

This review identifies **5 critical implementation gaps**, **4 technical refinements to error & wire contracts**, and provides **concrete interface specifications** to make the design directly executable.

---

## 2. Critical Implementation & Architectural Gaps

### 2.1 Gap 1: Admission Control Mechanics in `EmbeddingWorkerCore` vs `SqliteEmbeddingPipeline` (§4.1)

#### The Issue

The spec states in §4.1:
> *"EmbeddingWorkerCore gains a permit lane. Backfill acquires one permit per item... An arriving `embed_texts` raises an interactive flag: backfill stops acquiring new permits, in-flight ones drain, the query embeds, permits resume."*

However, in the current codebase:

- `EmbeddingWorkerCore.runInit` calls `await this.runBackfill(pipeline)`.
- `SqliteEmbeddingPipeline.backfillAll` internally invokes `mapWithConcurrency(rows, this.backfillConcurrency, ...)` in a tight loop across pages.
- The pipeline has no visibility into incoming worker IPC messages, and the worker core does not currently intercept individual backfill item iterations.

#### Concrete Improvement

Introduce an explicit `AsyncPriorityGate` (or `EmbeddingPermitGate`) passed to `SqliteEmbeddingPipelineOptions`:

```typescript
export interface EmbeddingPriorityGate {
  /**
   * Background task (backfill or item indexing) acquires 1 of N permits.
   * Blocks if N permits are in use OR if an interactive request is pending.
   */
  acquireBackground(): Promise<() => void>;

  /**
   * Interactive request (embed_texts for search/ask) raises priority flag.
   * Suspends background permit acquisition and waits for in-flight background permits to drain.
   */
  acquireInteractive(): Promise<() => void>;
}
```

**Wiring in `SqliteEmbeddingPipeline.embedBatch`:**

```typescript
private async embedBatch(rows: readonly IndexedItem[], reportOne: () => void): Promise<void> {
  await mapWithConcurrency(rows, this.backfillConcurrency, async (row) => {
    const release = this.gate ? await this.gate.acquireBackground() : () => {};
    try {
      await this.embedItem(row);
    } catch (err) {
      this.logger?.warn({ err, itemId: row.id }, "embedding backfill item failed");
    } finally {
      release();
    }
    reportOne();
  });
}
```

This decouples the concurrency limiter from raw Promise pooling and guarantees that an incoming `embed_texts` pauses new backfill items at the single-item boundary (sub-second drain).

---

### 2.2 Gap 2: Live Sync `embed_item` Queue Starvation (§4.1)

#### The Issue

`EmbeddingWorkerCore.handleMessage` handles three message types:

1. `init` (starts `backfillAll`)
2. `embed_texts` (interactive query embeddings)
3. `embed_item` (single item embeddings scheduled from live connector syncs via `this.embedChain`)

When an initial sync runs (e.g. Google Drive / Slack syncing 5,000 files), thousands of `embed_item` messages arrive over IPC and drain through `this.embedChain`. If admission control only coordinates `backfillAll` vs `embed_texts`, the unthrottled `embed_item` chain will run concurrently with backfill and continue starving `embed_texts`.

#### Suggestion

`embed_item` must also acquire a background permit via `gate.acquireBackground()` inside `this.embedChain`, placing all background embedding workloads (backfill + sync queue) under the same priority preemption umbrella.

---

### 2.3 Gap 3: Coverage Query Performance on Every Search Query (§4.3)

#### The Issue

Section 4.3 states:
> *"Coverage is read, not recomputed. `nimbus index health` already computes per-connector embedding coverage; this block must agree with it rather than derive a second number that can disagree."*

In `packages/gateway/src/db/index-health.ts`, `collectIndexHealth` executes `readPerService`:

```sql
SELECT i.service AS service,
       COUNT(*) AS items,
       SUM(CASE WHEN e.item_id IS NULL THEN 0 ELSE 1 END) AS embedded
FROM item i
LEFT JOIN (SELECT DISTINCT item_id FROM embedding_chunk) e ON e.item_id = i.id
GROUP BY i.service
```

Running this full-table scan with `LEFT JOIN (SELECT DISTINCT...)` on **every single keystroke/search query** against a 60,000–500,000 item database will introduce a 20ms–150ms SQLite blocking penalty.

#### Concrete Improvement

Use a two-tier coverage resolution strategy:

1. **Live Fast Path (In-Memory Progress):** While backfill is active, `EmbeddingWorkerBridge.getBackfillProgress()` already holds `{ done, total }` pushed via `backfill_progress` messages. Reading this is $O(1)$ and zero-SQL.
2. **Indexed / Cached Metric:** For post-backfill queries or when the bridge is idle, cache index coverage with a TTL (e.g. 30s) or maintain an atomic fast-count cache invalidated on sync completion.

---

### 2.4 Gap 4: Missing Consumer in Scope: `toolgen-grounding.ts` (§4.5)

#### The Issue

Section 4.5 ("Consumers — enumerated") lists CLI, `nimbus ask`, MCP, Briefs, Doctor, HTTP, and Tauri.
However, `packages/gateway/src/toolgen/toolgen-grounding.ts` (line 77) calls:

```typescript
items = await index.searchRankedAsync({ itemType: "api_endpoint", name: query, limit });
```

and is tested by `packages/gateway/src/toolgen/toolgen-draft.test.ts` and `toolgen-grounding.test.ts`.

#### Suggestion

Add `toolgen` to the consumers matrix in §4.5. If `LocalIndex.searchRankedAsync` internal return signature changes, `toolgen-grounding.ts` must be updated.

---

### 2.5 Gap 5: CLI Output Contract & JSON Pipe Safety (`jq` compatibility) (§4.4 / §4.5)

#### The Issue

In `packages/cli/src/commands/search.ts` (lines 114, 157–161):

```typescript
const rows = await searchWithWarmingFallback(client, params, semantic);
console.log(JSON.stringify(rows, null, 2));
```

CLI search is designed to be pipe-friendly: `nimbus search "query" | jq '.[0]'`.
If the CLI passes `envelope: true` to the IPC call and dumps `{ items: [...], retrieval: {...} }` directly to `stdout`, existing scripts expecting a JSON array will break.

#### Recommendation

- By default, `nimbus search` passes `envelope: true` to IPC, prints the `items` array to `stdout`, and prints human-readable retrieval notes to `stderr` when degraded or partial:

  ```text
  [stderr] note: semantic search coverage is 14% (8,400/60,000 items). Run 'nimbus index health' for details.
  [stderr] note: semantic ranking timed out under load; displaying keyword-only (BM25) results.
  [stdout] [ { "id": "...", "title": "..." }, ... ]
  ```

- Add a `--json-envelope` CLI flag for programmatic consumers that want the full `{ items, retrieval }` JSON structure on `stdout`.

---

## 3. Refinements to Error Handling & Type Contracts

### 3.1 Typed Error Contract & JSON-RPC Mapping (§4.2)

Define the new error class alongside `EmbeddingWarmingError` in `packages/gateway/src/embedding/embedding-readiness.ts`:

```typescript
export const EMBEDDING_TIMEOUT_CODE = "embedding_timeout" as const;
export const EMBEDDING_TIMEOUT_RPC_CODE = -32022;

export class EmbeddingTimeoutError extends Error {
  readonly code = EMBEDDING_TIMEOUT_CODE;
  readonly readiness: EmbeddingReadiness;

  constructor(readiness: EmbeddingReadiness, timeoutMs: number) {
    super(`embedding query timed out after ${timeoutMs}ms under load`);
    this.name = "EmbeddingTimeoutError";
    this.readiness = readiness;
  }
}

export function isEmbeddingTimeoutError(err: unknown): err is EmbeddingTimeoutError {
  if (err instanceof EmbeddingTimeoutError) return true;
  if (typeof err !== "object" || err === null) return false;
  return (err as { code?: unknown }).code === EMBEDDING_TIMEOUT_CODE;
}
```

### 3.2 Tight Timeout Budget Recommendation & Configurability

- **Inner Timeout:** Set default `DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS = 5000` (5 seconds).
  - *Rationale:* 5s allows 1–2 in-flight background items (each ~50–300ms) to drain on low-end CPUs without making the user wait, leaving 25s headroom before the CLI's 30s transport timeout.
- **Configurability:** Support env override `NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS` and optional `[embedding] query_timeout_ms` in `nimbus.toml`.

### 3.3 Gateway Internal Architecture: Return Type Consistency

To ensure gateway-internal callers (`briefs`, `toolgen`, MCP, IPC handlers) benefit from structural disclosure without duplication:

1. `LocalIndex.searchRankedAsync` **always** returns `SearchRankedEnvelope`:

   ```typescript
   export interface SearchRankedEnvelope {
     readonly items: RankedIndexItem[];
     readonly retrieval: SearchRetrievalDisclosure;
   }
   ```

2. The IPC handler `rpcSearchRanked` in `packages/gateway/src/ipc/server/inline-handlers.ts` inspects `params.envelope`:

   ```typescript
   const result = await ctx.options.localIndex.searchRankedAsync(query, { ... });
   return params.envelope === true ? result : result.items;
   ```

   *Benefit:* Zero chance of gateway subsystems dropping or misinterpreting retrieval metadata, while guaranteeing 100% backward compatibility for legacy external IPC clients.

---

## 4. Concrete Schema & Interface Specifications

### 4.1 `SearchRetrievalDisclosure` Schema

```typescript
export type UnrankedReason =
  | "warming"       // Model still downloading / initializing
  | "timeout"       // Query embedding timed out under worker contention
  | "unavailable"   // Embedder crashed or failed to load
  | "disabled"      // Semantic search disabled in config or by policy
  | "empty_query";  // Query string contained no embeddable tokens

export interface EmbeddingCoverageSummary {
  readonly embeddedItems: number;
  readonly totalItems: number;
  readonly percent: number; // 0.0 to 100.0, rounded to 1 decimal
}

export interface SearchRetrievalDisclosure {
  /** True if results were ranked using vector/hybrid scoring; false if keyword-only (BM25). */
  readonly vectorRanked: boolean;
  /** Populated when vectorRanked is false to explain the exact degradation cause. */
  readonly unrankedReason: UnrankedReason | null;
  /** Live embedding index coverage at the moment of query execution. */
  readonly coverage: EmbeddingCoverageSummary | null;
}
```

### 4.2 Worker Priority Gate Reference Implementation

```typescript
export class AsyncPriorityGate implements EmbeddingPriorityGate {
  private inFlightBackground = 0;
  private interactivePending = 0;
  private readonly maxBackground: number;
  private readonly bgQueue: Array<() => void> = [];
  private readonly intQueue: Array<() => void> = [];

  constructor(concurrency = 8) {
    this.maxBackground = Math.max(1, concurrency);
  }

  async acquireBackground(): Promise<() => void> {
    while (this.interactivePending > 0 || this.inFlightBackground >= this.maxBackground) {
      await new Promise<void>((resolve) => this.bgQueue.push(resolve));
    }
    this.inFlightBackground += 1;
    return () => {
      this.inFlightBackground -= 1;
      this.drain();
    };
  }

  async acquireInteractive(): Promise<() => void> {
    this.interactivePending += 1;
    while (this.inFlightBackground > 0) {
      await new Promise<void>((resolve) => this.intQueue.push(resolve));
    }
    return () => {
      this.interactivePending -= 1;
      this.drain();
    };
  }

  private drain(): void {
    if (this.interactivePending > 0) {
      if (this.inFlightBackground === 0 && this.intQueue.length > 0) {
        const next = this.intQueue.shift();
        next?.();
      }
      return;
    }
    while (this.inFlightBackground < this.maxBackground && this.bgQueue.length > 0) {
      const next = this.bgQueue.shift();
      next?.();
    }
  }
}
```

---

## 5. Answers to Open Questions & Residuals (§7)

### 5.1 ONNX Inference & JS Event Loop Concurrency in Bun

- **Finding:** `@xenova/transformers` with `onnxruntime-node` performs tokenization in JS and delegates tensor math (`session.run()`) to native ONNX threadpools.
- **Impact on Admission Control:**
  - When 8 background inferences run concurrently, native CPU threads saturate available hardware cores, slowing down both JS microtasks and subsequent inferences.
  - Pausing background permit acquisition allows the 8 in-flight inferences to finish, immediately freeing CPU cores for the interactive query.
  - The measured latency will be bounded by `max(time_to_finish_1_active_item)` ($\approx 50\text{--}250\text{ ms}$) rather than the remaining 60,000 items ($\text{hours}$).

### 5.2 Third-Party Client Contract Verification

- Verified that `@nimbus-dev/client` 0.17.3 asserts `Array.isArray(res)` on `NimbusClient.searchRanked`.
- The opt-in `envelope: true` design safely avoids breaking external clients while allowing all first-party Nimbus CLI, MCP, and VS Code extensions to pass `envelope: true` immediately.

---

## 6. Recommended PR & Delivery Sequence

To maintain test isolation and allow independent verification, implement in three clean PRs:

1. **PR 1: Reproduction Test & Worker Admission Control (§4.1)**
   - Add self-validating reproduction test reproducing timeout under 60k-item saturated backfill.
   - Implement `AsyncPriorityGate` in `EmbeddingWorkerCore` and wire into `SqliteEmbeddingPipeline`.
   - Verify that interactive query latency drops from $>30\text{s}$ (timeout) to $<300\text{ms}$ during active backfill.

2. **PR 2: Error Contract & Timeout Ordering (§4.2)**
   - Add `EmbeddingTimeoutError` and brand-checked guards.
   - Reduce inner timeout from 60s to 5s.
   - Update `embedQueryBestEffort` and `embedQueryDualBestEffort` to capture swallowed failure reasons.

3. **PR 3: Disclosure Construction & Consumer Rollout (§4.3 – §4.5)**
   - Implement `SearchRankedEnvelope` and `SearchRetrievalDisclosure` in `LocalIndex.searchRankedAsync`.
   - Wire `envelope: true` opt-in handling into IPC `rpcSearchRanked`.
   - Update CLI `nimbus search` (stderr notes + stdout safety) and MCP server adapter.
