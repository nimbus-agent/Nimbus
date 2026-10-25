# Antigravity review — spec § 8 (P2 PR 3, Google Docs text)

Reviewer: Google Antigravity CLI (`agy --mode plan`), read-only bundle of origin/main sources + the spec, 2026-10-25. Findings verbatim, then the disposition.

### 1. Stale MiniLM Embeddings on In-Place Type Change to `google_drive:doc`
- **Severity:** Critical
- **Evidence:** 
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L304-L305)
  - Codebase: [`SqliteEmbeddingPipeline.embedItem`](packages/gateway/src/embedding/pipeline.ts#L137-L141), [`RoutingEmbeddingPipeline.embedItem`](packages/gateway/src/embedding/routing-pipeline.ts#L15-L18), [`upsertIndexedItem`](packages/gateway/src/index/item-store.ts#L117-L132)
- **Problem:** Section 8 asserts: *"A rewritten row changes type, so it is re-embedded under `google_drive:doc`'s routing (`google_drive:file` is in neither routing set today); the old vector goes with the old row."* This claim is false. Because the Doc reuses the file's primary key (`id = google_drive:<fileId>`), the row is updated in place via `ON CONFLICT(id) DO UPDATE SET type = excluded.type`. The row is never deleted. When `RoutingEmbeddingPipeline.embedItem` routes `google_drive:doc` to `this.openai` (since it joins `PROSE_HEAVY_TYPES`), `SqliteEmbeddingPipeline.embedItem` runs `DELETE FROM embedding_chunk WHERE item_id = ? AND model = ?` using `this.openai.embedder.model`. The prior 384-dim MiniLM vector in `vec_items_384` and `embedding_chunk` under `this.local.embedder.model` is never deleted. The item will permanently retain dual, divergent vectors across both embedding tables.
- **Fix:** Update § 8 to require that `RoutingEmbeddingPipeline.embedItem` (or the rewrite path) deletes all chunks for `item.id` across all models (`DELETE FROM embedding_chunk WHERE item_id = ?` via `deleteItemEmbeddings(item.id)`) before inserting vectors into the newly routed target.

---

### 2. Uncaught Export Errors Cause Permanent Drive Sync Failure Loop
- **Severity:** Critical
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L292-L294)
  - Codebase: [`fetchGoogleJson`](packages/gateway/src/connectors/google-sync-shared.ts#L55-L61), [`createGoogleDriveSyncable.sync`](packages/gateway/src/connectors/google-drive-sync.ts#L446-L469)
- **Problem:** Section 8 notes: *"A text variant of `fetchGoogleJson` (`google-sync-shared.ts:38`) goes through the same rate limiter and 401 handling."* Under `google-sync-shared.ts`, any non-2xx response status throws an exception (`formatGoogleHttpError`). Google Docs export routinely fails per document on 403 (file download/export disabled by domain DLP or owner permissions), 404 (deleted/unshared mid-sync), 413 (>10MB export payload limit), or 500 (Google conversion backend timeout). In `google-drive-sync.ts`, an uncaught throw aborts `sync()`, causing the scheduler to discard the next cursor. On the next tick 30 minutes later, the sync retries the exact same document, fails, and gets trapped in an unrecoverable failure loop.
- **Fix:** Specify per-Doc error handling in § 8 mirroring [`notionConsumeSearchResultRow`](packages/gateway/src/connectors/notion-sync.ts#L230-L234). Errors on 401 (re-auth) and 429 (rate limit) propagate; non-auth HTTP errors (403, 404, 413, 500) must be caught per Doc, logged as warnings, set `metadata.bodyFetch = "errored"`, and allow the file to be upserted with metadata/preview so the sync and cursor advance.

---

### 3. Cap Overflow Drops Unexported Docs Forever (Missing Body-Fetch State Tracking)
- **Severity:** Critical
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L298-L301)
  - Codebase: [`runDriveChangePage`](packages/gateway/src/connectors/google-drive-sync.ts#L311-L332), [`selectItemBodyFetchState`](packages/gateway/src/index/item-store.ts#L293-L316), [`notion-sync.ts`](packages/gateway/src/connectors/notion-sync.ts#L199-L204)
- **Problem:** The export cap is fixed at 200 per run. When initial sync or a delta batch contains >200 Docs (e.g. 500 Docs), the 200-export allowance is reached. If Drive sync upserts the remaining 300 Docs without bodies and advances the cursor (`newStartPageToken` in changes or `listToken`), Google Drive's Changes API will never report those files again unless they are edited upstream. Those Docs remain bodyless in SQLite forever. Section 8 specifies no body-fetch state tracking or cursor pausing mechanism.
- **Fix:** Update § 8 to incorporate `ctx.bodyFetchState` and `metadata.bodyFetch` (`"complete" | "capped" | "errored"`). When the 200-export cap is reached, Drive sync must either pause page advancement and return `hasMore: true`, or defer remaining Docs to a resumable queue/cursor state that subsequent syncs drain before advancing the change watermark.

---

### 4. Scope Widening Beyond the 30-Day Initial Window During Doc Re-list
- **Severity:** Critical
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L297-L298)
  - Codebase: [`listQueryForInitial`](packages/gateway/src/connectors/google-drive-sync.ts#L122-L124), [`createGoogleDriveSyncable`](packages/gateway/src/connectors/google-drive-sync.ts#L389-L403)
- **Problem:** Section 8 specifies: *"Existing Docs: the changes cursor only sees changed files, so a one-time re-list of Docs (`mimeType = 'application/vnd.google-apps.document'`) rewrites them as `doc` with text, resumable through the cursor, bounded per run."* Drive sync enforces `initialSyncDepthDays = 30` with `trashed = false and modifiedTime > '${sinceIso}'`. Querying the Drive API with bare `mimeType = 'application/vnd.google-apps.document'` lists and exports every Doc across the user's entire account history (potentially thousands of ancient docs), including files in trash, violating the 30-day initial sync contract and Anti-goal #5 (*"A Drive sync that now pulls every file's bytes"*).
- **Fix:** Specify that re-listing operates on existing rows in SQLite (`SELECT id, external_id FROM item WHERE service = 'google_drive' AND type = 'file' AND json_extract(metadata, '$.mimeType') = 'application/vnd.google-apps.document'`), ensuring it strictly upgrades previously synced files. If queried via Drive API, it must explicitly include `trashed = false and modifiedTime > '${sinceIso}'` (or `ctx.historyFloorMs`).

---

### 5. Missing Cursor Phase Definition for Existing Delta Cursors vs Re-list
- **Severity:** Important
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L297-L301)
  - Codebase: [`DriveSyncCursorV1`](packages/gateway/src/connectors/google-drive-sync.ts#L44-L48), [`decodeDriveSyncCursor`](packages/gateway/src/connectors/google-drive-sync.ts#L100-L120)
- **Problem:** `DriveSyncCursorV1` defines only three phases: `init_list`, `drain`, and `delta`. Existing deployed instances have cursors persisted in `scheduler_state` as `nimbus-gdrv1:{"v":1,"phase":"delta","pageToken":"..."}`. When upgraded, `decodeDriveSyncCursor` decodes this directly into `runDrivePhaseDelta`, completely bypassing the re-list. Section 8 requires re-listing to be *"resumable through the cursor, bounded per run"*, but does not define the cursor schema. Moreover, if a re-list pauses delta polling across multiple runs, Google Drive change tokens expire, dropping intermediate changes.
- **Fix:** Define the cursor schema upgrade in § 8: introduce `DriveSyncCursorV2` (or extend `DriveSyncCursorV1`) to track both `deltaPageToken` and an optional `relistCursor` (or `relistDone: boolean`), allowing delta changes to drain every sync while the re-list proceeds incrementally with the remaining export budget.

---

### 6. Wasted Egress and Rate Limits Under `metadata_only` Depth
- **Severity:** Important
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L288-L294)
  - Codebase: [`SyncContext.depth`](packages/gateway/src/sync/types.ts#L67), [`applyDepth`](packages/gateway/src/index/item-store.ts#L181-L206)
- **Problem:** When a connector is configured with `depth = "metadata_only"`, [`applyDepth`](packages/gateway/src/index/item-store.ts#L199) forces `body: ""` and `bodyTruncated: true`. Section 8 specifies exporting Docs whenever `modifiedTime` changes, without checking `ctx.depth`. In `metadata_only` mode, Drive sync will issue up to 200 export requests per sync run, downloading full text over the network, only for `upsertIndexedItemForSync` to immediately discard the text.
- **Fix:** In § 8, state that if `ctx.depth === "metadata_only"`, Drive sync skips calling the export endpoint entirely and indexes `google_drive:doc` with title, metadata, and empty body.

---

### 7. Violation of `index-rebody-rpc.ts` Service Completeness Invariant
- **Severity:** Important
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L288-L305)
  - Codebase: [`REBODY_IMPROVABLE_SERVICES`](packages/gateway/src/ipc/index-rebody-rpc.ts#L206-L217), [`index-rebody-rpc.ts:263-267`](packages/gateway/src/ipc/index-rebody-rpc.ts#L263-L267)
- **Problem:** `index-rebody-rpc.ts` governs `nimbus index rebody`. It documents an explicit invariant: services with mixed completeness (some types pass `body:`, others only `bodyPreview:`, such as `zoom` and `nimbus`) are strictly EXCLUDED from `REBODY_IMPROVABLE_SERVICES` because `computePendingByService` groups by `service` only. Adding `google_drive:doc` with `body:` while `file` and `folder` remain `bodyPreview`-only makes `google_drive` a mixed-completeness service. Section 8 does not define the posture for `rebody`. If `google_drive` is added to `REBODY_IMPROVABLE_SERVICES`, every non-Doc Drive file will report as "pending body recovery" that can never complete; if excluded, users cannot rebody Google Docs.
- **Fix:** Section 8 must state that `google_drive` remains excluded from `REBODY_IMPROVABLE_SERVICES` (mirroring `zoom` and `nimbus`), and note that supporting rebody for Google Docs requires updating `computePendingByService` in `index-rebody-rpc.ts` to group by `(service, type)`.

---

### 8. Unstripped UTF-8 Byte Order Mark (BOM) in `text/plain` Export
- **Severity:** Important
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L284-L285)
  - Codebase: [`fetchGoogleJson`](packages/gateway/src/connectors/google-sync-shared.ts#L38-L68), [`upsertIndexedItem`](packages/gateway/src/index/item-store.ts#L89-L92)
- **Problem:** Google Drive's export endpoint (`/drive/v3/files/{id}/export?mimeType=text/plain`) returns UTF-8 text prepended with a Byte Order Mark (`0xEF 0xBB 0xBF`, JavaScript `\uFEFF`). In JavaScript, `await res.text()` retains `\uFEFF` as index 0. If stored directly in `item.body`, it corrupts token boundary indexing in FTS5, breaks line-start regexes (`^#`) in decision extractors, and leaves invisible characters in `body_preview`.
- **Fix:** Specify in § 8 that the text export helper in `google-sync-shared.ts` must strip leading BOM: `raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw`.

---

### 9. Contradictions with Owner Decisions in § 8, § 9, and § 11
- **Severity:** Minor
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md:290-301, 350-352](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L290-L301)
  - Codebase: [`itemPrimaryKey`](packages/gateway/src/index/item-key.ts#L7-L13), [`upsertIndexedItem`](packages/gateway/src/index/item-store.ts#L82,L117-L132)
- **Problem:** Section 8 and Section 11 contain obsolete statements that contradict finalized owner decisions:
  1. § 8:291-292 and § 11:351 state routing is *"the builder's call"*, whereas the owner has already decided `google_drive:doc` joins `PROSE_HEAVY_TYPES`.
  2. § 8:300-301 and § 11:350 state the export cap is *"the builder's"*, whereas the owner has decided it is 200 per run.
  3. § 8:299-300 and § 11:352 state the row id scheme is *"the builder's"* and query whether old rows are *"same item id if the id scheme allows, otherwise deleted"*. In `item-key.ts:7-13`, `itemPrimaryKey(service, externalId)` is `google_drive:<fileId>` (independent of `type`), and `upsertIndexedItem` does `ON CONFLICT(id) DO UPDATE SET type = excluded.type`.
- **Fix:** Update § 8 and § 11 to remove builder delegation and align directly with the owner decisions (joins `PROSE_HEAVY_TYPES`, 200 cap per run, replace in place reusing `google_drive:<fileId>`).

---

### 10. Inaccurate Citation for Media Pipeline MIME Handling
- **Severity:** Minor
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L286-L287)
  - Codebase: [`media-source-registry.ts:82-86,172`](packages/gateway/src/multimodal/media-source-registry.ts#L82-L86), [`media-discovery.ts:101-104`](packages/gateway/src/multimodal/media-discovery.ts#L101-L104)
- **Problem:** Section 8 cites: *"the media pipeline reads them, `multimodal/media-source-registry.ts:128,172`"*. Line 128 of `media-source-registry.ts` is a comment in a docstring discussing hypothetical MIME pairs. The actual reading of `mimeType` occurs in `media-discovery.ts:102` (`json_extract(src.metadata, '$.mimeType')`) and `media-source-registry.ts:82-86` (`MIME_KEYED_SERVICES`). Line 172 is `SOURCE_BYTES_KEY` which reads `size`.
- **Fix:** Update citation in § 8 to reference `multimodal/media-source-registry.ts:82-86,172` and `multimodal/media-discovery.ts:101-104`.

---

### 11. Mischaracterization of `LONG_BODY_TYPES` Derivation
- **Severity:** Minor
- **Evidence:**
  - Spec: [2026-10-25-role-packs-p2-source-mapping-design.md](plan/2026-10-25-role-packs-p2-source-mapping-design.md#L288-L290)
  - Codebase: [`LONG_BODY_TYPES`](packages/gateway/src/index/body-caps.ts#L27-L34)
- **Problem:** Section 8 states: *"`google_drive:doc` joins the long-body prose types so `full` depth stores up to `BODY_MAX_PROSE` (16,384)."* This implies `LONG_BODY_TYPES` is an independent table requiring a manual edit. In reality, `LONG_BODY_TYPES` in `body-caps.ts:27-30` is derived: `new Set([...PROSE_HEAVY_TYPES, ...LOCAL_ONLY_PROSE_TYPES])`. Adding `google_drive:doc` to `PROSE_HEAVY_TYPES` automatically grants it the 16 KiB prose cap.
- **Fix:** Clarify in § 8 that `google_drive:doc` receives `BODY_MAX_PROSE` automatically via its membership in `PROSE_HEAVY_TYPES`.

## Disposition

| # | Finding | Disposition | Why |
|---|---------|-------------|-----|
| 1 | Stale MiniLM vector on in-place re-type | **Fixed** (§ 8) | Verified, and worse than stated: `embedding_chunk` is `UNIQUE(item_id, chunk_index)`, so the new route's insert FAILS and the stale vector stays the only one. `RoutingEmbeddingPipeline.embedItem` deletes other-model chunks first. |
| 2 | Export errors fail the whole sync | **Fixed** (§ 8) | Per-Doc catch; only 401 throws. Declined: recording `bodyFetch: "errored"` — Notion's convention is no verdict (retryable), kept. Declined: propagating 429 — caught, and it re-arms the re-list instead of failing the page. |
| 3 | Cap overflow leaves Docs bodyless forever | **Fixed** (§ 8) | Overflow and transient failures re-arm the re-list; the re-list never starts a page it cannot finish. Changes pages are ≤100 files, under the 200 cap. |
| 4 | Re-list widens scope past the 30-day window | **Fixed** (§ 8) | Re-listed Docs are written only if already indexed or inside the window; `trashed = false` added to the query. Declined: driving the re-list from SQLite rows — needs a new SyncContext capability (D24 boundary) for no gain over the scope filter. |
| 5 | No cursor schema for the re-list | **Fixed** (§ 8) | `docs` field on the `delta` cursor, absent = not started; the changes page is applied first every call, so the token cannot expire behind the re-list. |
| 6 | Exports wasted at `metadata_only` | **Fixed** (§ 8) | No export at `metadata_only`; verdict recorded only at `full` (a `summary` verdict would block a later deepen). Also added `hasBody`, since a `metadata_only` reindex NULLs the body but keeps the verdict. |
| 7 | rebody posture for a mixed service | **Fixed** (§ 8) | `google_drive` stays out of `REBODY_IMPROVABLE_SERVICES`, stated. |
| 8 | Leading BOM on `text/plain` export | **Fixed** (§ 8) | `fetchGoogleText` strips it. |
| 9 | § 8/§ 11 still delegate settled owner calls | **Fixed** | Both sections state the owner's calls. |
| 10 | Wrong media-pipeline citation | **Fixed** | Cites `media-source-registry.ts:82-86,172` and the mime arm of `media-discovery.ts`. |
| 11 | `LONG_BODY_TYPES` is derived | **Fixed** | Stated as derived. |
