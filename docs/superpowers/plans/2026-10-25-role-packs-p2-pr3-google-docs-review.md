# Antigravity review — P2 PR 3 plan (and the branch implementing it)

Reviewer: Google Antigravity CLI (`agy --mode plan`), 2026-10-25. The first run (a bundle of whole source directories) hit its 15-minute print timeout and returned nothing; the second ran on the plan, spec § 8, `branch.diff` and the touched files. Findings verbatim, then the disposition.

### Review Findings

#### 1. [Critical] Cross-model chunk delete in `RoutingEmbeddingPipeline.embedItem` leaves `backfillForRoutingKeys` in an infinite loop
- **File & Line:** [`packages/gateway/src/embedding/routing-pipeline.ts:21-25`](packages/gateway/src/embedding/routing-pipeline.ts#L21-L25) and [`packages/gateway/src/embedding/pipeline.ts:138-141,271-290`](packages/gateway/src/embedding/pipeline.ts#L138-L141)
- **Evidence:**
  `RoutingEmbeddingPipeline.embedItem` deletes chunks under other models before delegating:
  ```ts
  dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ? AND model <> ?`, [
    item.id,
    target.embeddingModel,
  ]);
  await target.embedItem(item);
  ```
  However, `RoutingEmbeddingPipeline.backfillAll` bypasses `RoutingEmbeddingPipeline.embedItem` and calls `target.backfillForRoutingKeys(...)`, which drains items via `SqliteEmbeddingPipeline.embedBatch` calling `SqliteEmbeddingPipeline.embedItem(row)`.
  Inside `SqliteEmbeddingPipeline.embedItem`:
  ```ts
  dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ? AND model = ?`, [
    itemId,
    model,
  ]);
  ```
  It only deletes chunks where `model = ?`. If an existing item (e.g., an existing Doc previously embedded under `MiniLM`) changes routes to `openai`, the old `MiniLM` chunks remain. Because `embedding_chunk` enforces `UNIQUE(item_id, chunk_index)`, inserting the new chunks throws `SQLITE_CONSTRAINT_UNIQUE`.
  `embedBatch` catches and logs the error, leaving the row un-embedded under the target model. On the next iteration of the `while (true)` drain loop in `backfillForRoutingKeys`:
  ```ts
  WHERE NOT EXISTS (SELECT 1 FROM embedding_chunk c WHERE c.item_id = i.id AND c.model = ?)
  ```
  The row is re-selected continuously, causing an **infinite loop** in backfill.
- **Fix:** In [`packages/gateway/src/embedding/pipeline.ts:138-141`](packages/gateway/src/embedding/pipeline.ts#L138-L141), change:
  ```ts
  dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ? AND model = ?`, [
    itemId,
    model,
  ]);
  ```
  to:
  ```ts
  dbRun(this.db, `DELETE FROM embedding_chunk WHERE item_id = ?`, [itemId]);
  ```
  Because `(item_id, chunk_index)` is unique, an item can only belong to one model at a time. Clearing all chunks for `item_id` upon embedding eliminates the cross-model conflict uniformly across both real-time embedding and backfill.

---

#### 2. [Important] Missed caller: `notion-sync.ts` does not check `hasBody`
- **File & Line:** [`packages/gateway/src/connectors/notion-sync.ts:200`](packages/gateway/src/connectors/notion-sync.ts#L200)
- **Evidence:**
  Spec § 8 lines 28–32 states:
  > *"`ctx.bodyFetchState` (the Notion pattern, `connectors/notion-sync.ts:200`) gains `hasBody`, and the export is skipped only when a `bodyFetch` verdict is recorded, the body is present and `modifiedAt` is unchanged. `hasBody` matters because a `metadata_only` reindex NULLs the body but keeps the verdict (`connectors/reindex.ts`)."*
  
  `ItemBodyFetchState` was updated to include `hasBody: boolean`, but `notion-sync.ts:200` was left untouched and continues to check only `prior.bodyFetch !== null && prior.modifiedAt === modifiedAt`.
  Plan Task 4 noted *"Notion ignores it"*, but this leaves Notion vulnerable to the exact defect `hasBody` was designed to fix: after a `metadata_only` reindex, Notion pages with a verdict are skipped and will never re-fetch their bodies upon subsequent syncs.
- **Fix:** In [`packages/gateway/src/connectors/notion-sync.ts:200`](packages/gateway/src/connectors/notion-sync.ts#L200), update the skip condition to require `prior.hasBody === true`:
  ```ts
  if (prior !== null && prior.bodyFetch !== null && prior.hasBody && prior.modifiedAt === modifiedAt) {
    return false;
  }
  ```

---

#### 3. [Important] Tests in `google-sync-shared.test.ts` cannot fail if `GoogleHttpError` is broken
- **File & Line:** [`packages/gateway/src/connectors/google-sync-shared.test.ts:8,337-355`](packages/gateway/src/connectors/google-sync-shared.test.ts#L8)
- **Evidence:**
  `GoogleHttpError` was added to `google-sync-shared.ts:39` to provide structured HTTP error statuses (`status: number`) so callers can distinguish 429/5xx from 403.
  However, in `google-sync-shared.test.ts`:
  1. `GoogleHttpError` is not imported at all (line 8).
  2. The failure assertions only use substring matches via `.rejects.toThrow(...)`:
     ```ts
     await expect(
       fetchGoogleText(ctx, "tok", "https://example.com/export", "Google Drive"),
     ).rejects.toThrow("Google Drive sync failed: 403 — This file is too large to be exported.");
     ```
  If `fetchGoogleOk` threw a plain `new Error(msg)` without `GoogleHttpError` or without `status`, this test would still pass. The type and `status` property are never verified in the module's test suite.
- **Fix:** Import `GoogleHttpError` in `google-sync-shared.test.ts` and assert the error type and status explicitly:
  ```ts
  let thrown: unknown;
  try {
    await fetchGoogleText(ctx, "tok", "https://example.com/export", "Google Drive");
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(GoogleHttpError);
  expect((thrown as GoogleHttpError).status).toBe(403);
  ```

---

#### 4. [Important] Plan mismatch: Test file location for Google Docs tests
- **File & Line:** [`plan/2026-10-25-role-packs-p2-pr3-google-docs.md:54,81,137`](plan/2026-10-25-role-packs-p2-pr3-google-docs.md#L54)
- **Evidence:**
  - Plan Task 5 specifies: *"Files: connectors/google-drive-sync.ts; tests in test/unit/connectors/google-drive-sync.test.ts (new describe blocks)"*.
  - Plan Task 6 specifies: *"tests as Task 5"*.
  - Plan verification line 137 instructs: *"bun test packages/gateway/test/unit/connectors/google-drive-sync.test.ts (the test/ tree is not loaded by a src run)"*.
  
  In the branch, all new Drive Docs tests were placed in a new file [`packages/gateway/src/connectors/google-drive-docs.test.ts`](packages/gateway/src/connectors/google-drive-docs.test.ts), while `test/unit/connectors/google-drive-sync.test.ts` only had two cursor-pinning fixtures updated. Running the command in the plan's verification section does not execute the new Google Docs tests.
- **Fix:** Update lines 54, 81, and 137 in `plan/2026-10-25-role-packs-p2-pr3-google-docs.md` to reference `packages/gateway/src/connectors/google-drive-docs.test.ts`.

---

#### 5. [Important] Unspecified `DOCS_RELIST_PAGES_PER_SYNC = 5` page bound in `google-drive-sync.ts`
- **File & Line:** [`packages/gateway/src/connectors/google-drive-sync.ts:86,499`](packages/gateway/src/connectors/google-drive-sync.ts#L86)
- **Evidence:**
  Spec § 8 lines 56–59 and Plan Task 6 specify that the re-list runs *"while ≥100 exports remain"*, with no page count bound:
  > *"The re-list runs only once the feed is caught up, with the call's remaining budget, and never starts a list page it cannot finish (at least 100 exports left)..."*
  
  The implementation introduces an unspec'd constant:
  ```ts
  export const DOCS_RELIST_PAGES_PER_SYNC = 5;
  ```
  and stops after 5 pages even if 200 exports remain (e.g. when pages contain already-current Docs). While reasonable as a throttling mechanism, it is an undocumented behavior departure from both the spec and the plan.
- **Fix:** Update `plan/spec-section-8.md` and `plan/2026-10-25-role-packs-p2-pr3-google-docs.md` (Task 6) to document `DOCS_RELIST_PAGES_PER_SYNC = 5` as an explicit constraint.

---

#### 6. [Minor] Stale describe block title referencing deleted function in `google-drive-sync.test.ts`
- **File & Line:** [`packages/gateway/test/unit/connectors/google-drive-sync.test.ts:866,867,892`](packages/gateway/test/unit/connectors/google-drive-sync.test.ts#L866)
- **Evidence:**
  Lines 866–892 retain describe/test titles referencing `runDriveChangePage` and line 316:
  ```ts
  describe("google-drive-sync — runDriveChangePage nextPageToken branch (L316)", () => {
    test("delta page with nextPageToken → hasMore=true with new delta cursor (L316)", ...);
  ```
  `runDriveChangePage` was removed in the async rewrite and replaced by `runDrivePhaseDrain` and `runDrivePhaseDelta`.
- **Fix:** Update the describe block title to `describe("google-drive-sync — runDrivePhaseDelta nextPageToken branch", () => { ... })`.

---

#### 7. [Minor] Incomplete re-arm verification in `google-drive-docs.test.ts`
- **File & Line:** [`packages/gateway/src/connectors/google-drive-docs.test.ts:263-279`](packages/gateway/src/connectors/google-drive-docs.test.ts#L263-L279)
- **Evidence:**
  In `test("a 429 indexes the Doc without text and re-arms the finished re-list")`, the re-list endpoint is stubbed with an empty response:
  ```ts
  fetchStub.respond("GET", RELIST_RE, { files: [] });
  ```
  Because `files` is empty, `runDocsRelist` does not iterate over any files and immediately marks `docs: RELIST_DONE`. The test verifies `relistCalls() === 1`, but never verifies that `d1` (the failed Doc) is re-evaluated and exported during the re-list.
- **Fix:** In `google-drive-docs.test.ts:271`, provide `files: [docFile("d1")]` and `fetchStub.respondWithText("GET", EXPORT_RE, "d1 retry text")`, then assert that `row("d1")?.body === "d1 retry text"`.

---

#### 8. [Minor] Counterintuitive `hasBody: true` semantics for items with only `bodyPreview`
- **File & Line:** [`packages/gateway/src/index/item-store.ts:321`](packages/gateway/src/index/item-store.ts#L321) and [`packages/gateway/src/index/item-store-body.test.ts:181-199`](packages/gateway/src/index/item-store-body.test.ts#L181-L199)
- **Evidence:**
  `selectItemBodyFetchState` checks `(body IS NOT NULL) AS has_body`. In `upsertIndexedItem`, `body` is set from `row.body ?? row.bodyPreview ?? row.title`, so `body` in SQLite is never SQL `NULL` on insertion.
  In `item-store-body.test.ts`, item `p4` is inserted with `bodyPreview: ""` and no `body`, yet the test asserts:
  ```ts
  expect(selectItemBodyFetchState(d, "notion:p4")).toEqual({
    modifiedAt: 7,
    bodyFetch: null,
    hasBody: true,
  });
  ```
  `hasBody` reports `true` even though no body was ever fetched or supplied. While harmless when guarded by `bodyFetch !== null`, the naming is counterintuitive.
- **Fix:** Clarify in the `ItemBodyFetchState` docstring in `item-store.ts` that `hasBody` reflects `body IS NOT NULL` (specifically detecting whether a `metadata_only` reindex has stripped the body column).


## Disposition

| # | Finding | Disposition | Why |
|---|---------|-------------|-----|
| 1 | Backfill bypasses the router; cross-model conflict loops forever | **Fixed** (217b60a5) | Verified: under the old code the new backfill test hangs. The delete moved into `SqliteEmbeddingPipeline.embedItem` (all of the item's chunks); the router change was reverted as redundant. |
| 2 | Notion's skip ignores `hasBody` | **Fixed** (217b60a5) | Same defect; Notion now reads it, with a red-proven test. |
| 3 | `GoogleHttpError` type/status never asserted | **Fixed** (217b60a5) | The 403 test asserts the class, status and message. |
| 4 | Plan names the wrong test file | **Fixed** (plan) | Tests live in `src/connectors/google-drive-docs.test.ts` so a `src` run loads them. |
| 5 | `DOCS_RELIST_PAGES_PER_SYNC` undocumented | **Fixed** (plan + spec § 8) | Added when the page bound was found while writing the tests; now stated in both. |
| 6 | Stale describe title naming a deleted function | **Fixed** (217b60a5) | Renamed to `runDrivePhaseDelta page branches`. |
| 7 | 429 test does not prove the re-list restores text | **Fixed** (217b60a5) | The first export 429s, the re-list's retry succeeds, and the row ends with the text and a verdict. |
| 8 | `hasBody` name reads as "was fetched" | **Fixed** (217b60a5) | Docstring states it is `body IS NOT NULL` and why. |
