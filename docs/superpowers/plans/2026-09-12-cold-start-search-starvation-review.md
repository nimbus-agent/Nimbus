# Cold-Start Search Starvation Plan — Review & Improvements

**Date:** 2026-09-12 · **Review Target:** [`2026-09-12-cold-start-search-starvation.md`](./2026-09-12-cold-start-search-starvation.md) · **Status:** Complete Review

---

## 1. Executive Summary & Verdict

The implementation plan is exceptionally thorough, well-structured, and strictly adheres to test-driven development (failing test $\to$ implement $\to$ verify $\to$ commit), the three-PR delivery sequence, and Nimbus global constraints (no `any`, `exactOptionalPropertyTypes`, cross-platform paths, and no schema migrations).

This review identifies **4 critical code snippet bugs** in the plan that would fail typechecking or break existing test assertions during execution, **2 defensive unwrapping recommendations** to prevent breakage across existing unit test mocks, and provides **precise code corrections** for immediate incorporation into the plan.

---

## 2. Code Snippet Bugs & Corrections

### 2.1 Bug 1: Task 1 Step 1 — Invalid `createLocalEmbedder` Invocation

#### The Bug

In Task 1 Step 1 (line 108 of the plan):

```typescript
const embedder = await createLocalEmbedder(join(dir, "models"));
```

In `packages/gateway/src/embedding/model.ts` (lines 13–17, 37–43), `createLocalEmbedder` requires an options object (`CreateLocalEmbedderOptions`), not a bare string path:

```typescript
export type CreateLocalEmbedderOptions = {
  cacheDir: string;
  onProgress?: (progress: EmbeddingModelDownload) => void;
};
export async function createLocalEmbedder(options: CreateLocalEmbedderOptions, ...): Promise<Embedder>
```

#### The Fix

Update Task 1 Step 1 to pass the options object:

```typescript
const embedder = await createLocalEmbedder({ cacheDir: join(dir, "models") });
```

---

### 2.2 Bug 2: Task 4 Step 3 — `embed_texts_result` Error Payload Regression

#### The Bug

In Task 4 Step 3 (line 765 of the plan):

```typescript
// Plan code snippet:
this.sendToMain({ type: "embed_texts_result", id, ok: false, message: errMessage(err) });
```

In the existing codebase (`packages/gateway/src/embedding/embedding-worker-core.ts` line 235), the error payload key is named **`error`**, NOT `message`:

```typescript
this.sendToMain({ type: "embed_texts_result", id, ok: false, error: errMessage(err) });
```

Changing this key to `message` will silently break:

1. `EmbeddingWorkerBridge.handleEmbedTextsResultMessage` in `worker-bridge.ts`.
2. Existing unit test in `embedding-worker-core.test.ts` line 238:
   `expect(postsOfType(posts, "embed_texts_result")).toEqual([{ type: "embed_texts_result", id: "req-err", ok: false, error: "embed boom" }]);`

#### The Fix

Update Task 4 Step 3 to preserve the exact property key:

```typescript
this.sendToMain({ type: "embed_texts_result", id, ok: false, error: errMessage(err) });
```

---

### 2.3 Bug 3: Task 6 Step 1 — Unit Test Timeout Latency (Wall-Clock Budget)

#### The Bug

In Task 6 Step 1 (lines 987–989 of the plan):

```typescript
const promise = bridge.embedQuery("anything");
await advanceBeyondQueryBudget();
```

With the default query budget set to `DEFAULT_EMBEDDING_QUERY_TIMEOUT_MS = 5000` (5 seconds), letting wall-clock time expire in unit tests will add a 5-second delay to the test runner on every run.

#### The Fix

Explicitly override `NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS` to a small value (e.g. 20ms) within the test or use Bun timer mocks:

```typescript
it("throws EmbeddingTimeoutError instead of resolving null", async () => {
  const origEnv = process.env["NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS"];
  process.env["NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS"] = "25";
  try {
    const worker = makeSilentWorker();
    const bridge = makeReadyBridge(worker);
    const promise = bridge.embedQuery("anything");
    await expect(promise).rejects.toThrow(/did not answer within/);
    await promise.catch((err: unknown) => {
      expect(isEmbeddingTimeoutError(err)).toBe(true);
    });
  } finally {
    if (origEnv === undefined) {
      delete process.env["NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS"];
    } else {
      process.env["NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS"] = origEnv;
    }
  }
});
```

---

### 2.4 Bug 4: Task 10 Step 1 — Test Fixture Alignment in `search.test.ts`

#### The Bug

Task 10 Step 1 writes tests using:

```typescript
const client = fakeClient({ "index.searchRanked": ... });
const { stdout, stderr } = await runSearchCapturingOutput(client, "deploy");
```

However, `packages/cli/src/commands/search.test.ts` uses the fixture infrastructure:

```typescript
import { clearFixture, FAKE_SOCKET_PATH, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";
```

`out.stdout()` and `out.stderr()` are captured via module-level `captureOutput()`.

#### The Fix

Align Task 10 Step 1 with `search.test.ts`'s existing harness:

```typescript
describe("retrieval disclosure output", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("keeps stdout a bare JSON array so `| jq '.[0]'` still works", async () => {
    const mock = createMockIpcClient([
      {
        items: [{ id: "a", name: "Item A" }],
        retrieval: { vectorRanked: false, unrankedReason: "timeout", coverage: null },
      },
    ]);
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, ipcClient: mock.client });
    await runSearch(["deploy"]);

    const stdout = out.stdout();
    const parsed: unknown = JSON.parse(stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(stdout).not.toContain("retrieval");
  });
});
```

---

## 3. Defensive Unwrapping & Test Mock Compatibility

### 3.1 Unwrapping In-Process Callers (`run-ask.ts`, `agent.ts`, etc.)

#### Context

In `packages/gateway/src/engine/run-ask.test.ts` (lines 404, 902, 1031, 1073), `packages/gateway/src/engine/agent.test.ts` (lines 96–111, 1120), and `packages/gateway/src/toolgen/toolgen-grounding.test.ts`, numerous unit tests mock `localIndex.searchRankedAsync` by directly assigning:

```typescript
localIndex.searchRankedAsync = async () => [];
```

If `run-ask.ts` or `agent.ts` unconditionally reads `.items` off the return value:

```typescript
const primary = (await localIndex.searchRankedAsync(...)).items;
```

Then `primary` evaluates to `undefined`, causing immediate `TypeError: Cannot read properties of undefined (reading 'slice')` in those existing tests.

#### Recommendation

In `run-ask.ts`, `agent.ts`, `brief-index-search.ts`, and `toolgen-grounding.ts`, unwrap defensively:

```typescript
const res = await localIndex.searchRankedAsync(...);
const items = Array.isArray(res) ? res : res.items;
```

This guarantees complete resilience for both new envelopes and existing test mocks returning bare arrays without requiring extensive rewrites across older test files.

---

### 3.2 CLI Fallback Handling in `search.ts`

In `packages/cli/src/commands/search.ts`:
Existing CLI tests in `search.test.ts` pass mock responses as raw arrays `[[{ id: "github:pr_1", title: "My PR" }]]`.

When `searchWithWarmingFallback` executes:

```typescript
const raw = await searchWithWarmingFallback(client, { ...params, envelope: true }, semantic);
const items = Array.isArray(raw) ? raw : (raw as { items?: unknown[] }).items ?? [];
const retrieval = Array.isArray(raw) ? undefined : (raw as { retrieval?: RetrievalNote }).retrieval;

console.log(JSON.stringify(items, null, 2));
printRetrievalNotes(retrieval);
```

This ensures existing mock tests continue to pass seamlessly while supporting live gateway envelopes.

---

## 4. Concurrency & Gate Verification Summary

- **Priority Preemption:** `AsyncPriorityGate` in Task 2 implements asymmetric priority where `acquireInteractive()` immediately increments `interactivePending` synchronously, pausing background acquisitions and allowing in-flight background tasks (at most $N=8$) to drain while admitting the query without waiting for full idle drain.
- **Fairness & Re-entrancy:** `wakeWaiters()` drains `this.waiting` into a local slice and resolves each waiter. Waiters re-evaluate the `while (this.interactivePending > 0 || this.inFlightBackground >= this.maxBackground)` loop condition, ensuring FIFO fairness and preventing starvation.
- **`embed_item` Coverage:** Task 4 correctly routes `embed_item` through `acquireBackground()`, protecting search queries from live sync contention.

---

## 5. Checklist of Edits for Implementation

| Task | Location | Required Adjustment |
|---|---|---|
| **Task 1** | Step 1, line 108 | Change `createLocalEmbedder(path)` to `createLocalEmbedder({ cacheDir: path })`. |
| **Task 4** | Step 3, line 765 | Change `{ ok: false, message: ... }` to `{ ok: false, error: ... }`. |
| **Task 6** | Step 1, test | Set `process.env["NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS"] = "25"` to avoid 5s test sleep. |
| **Task 9** | Step 6, callers | Use `Array.isArray(res) ? res : res.items` for defensive mock compatibility. |
| **Task 10** | Step 1, test | Use `setFixture` / `out.stdout()` / `out.stderr()` to match `search.test.ts`. |
| **Task 10** | Step 3, `search.ts` | Normalize `raw` response to handle both array and `{ items, retrieval }` shapes. |
