# Role packs P2 PR 3 — Google Docs text + PM pack 1.1.0 (plan)

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md` § 8 (revised
2026-10-25 with the owner's calls and the Antigravity spec review, `…-p2-pr3-google-docs-spec-review.md`).
**Branch:** `dev/asaf/role-packs-p2-docs` from origin/main `fd292567` (PR 2b #1776 merged), worktree
`C:/gitrep/Nimbus/.claude/worktrees/role-packs-p2-docs`. No `docs/superpowers/**` on that branch.
**Execution:** inline by the controller (owner waived plan approval; Antigravity review replaces it).

Owner calls: `google_drive:doc` in `PROSE_HEAVY_TYPES`; 200 exports per `sync()` call; same item id.

No migration, no invariant, no egress class, no IPC method, no HITL type. `google_drive:doc` is NOT a
built-in source kind — the PM pack maps it.

## Task 1 — Re-routed items drop their old route's vector

Files: `embedding/pipeline.ts`, `embedding/routing-pipeline.test.ts`. (Revised after the plan review:
the fix lives in `SqliteEmbeddingPipeline.embedItem`, not the router, because the backfill calls the
inner pipeline directly.)

1. Test (red first): embed an item under a local-routed type, then the same id under a prose-heavy
   type, then local again; after each, the item's chunks are in ONE dims only and the other vec table
   is empty. Red today with `SQLITE_CONSTRAINT_UNIQUE` (`UNIQUE(item_id, chunk_index)`).
2. `SqliteEmbeddingPipeline.embedItem` deletes ALL of the item's chunks (both the empty-text branch
   and the write transaction), not only its own model's. The V30 delete triggers clear the vec rows.
3. Test: the backfill (`backfillForRoutingKeys`) over an item holding the other model's chunks
   finishes and leaves one model; under the old code the drain loop never ends.

## Task 2 — Routing

Files: `embedding/routing.ts`, `embedding/routing.test.ts`.

- Add `google_drive:doc` after `notion:page` with a one-line reason; exact-membership test 22 → 23.
  `LONG_BODY_TYPES` follows automatically (body-caps tests unchanged).

## Task 3 — `fetchGoogleText` + `GoogleHttpError`

Files: `connectors/google-sync-shared.ts`, `connectors/google-sync-shared.test.ts`.

1. Extract the fetch-and-check core (`fetchGoogleOk`) from `fetchGoogleJson`; `fetchGoogleJson`'s
   behaviour and messages are unchanged (its existing tests pass unmodified).
2. Non-401 failures throw `GoogleHttpError` (an `Error` subclass carrying `status`).
3. `fetchGoogleText` returns `{ text, bytes }`, stripping one leading U+FEFF.
4. Tests: BOM stripped and Authorization sent; non-JSON body returned verbatim; 401 →
   `UnauthenticatedError`; 403 → message with status.

## Task 4 — `bodyFetchState.hasBody`

Files: `index/item-store.ts` (`ItemBodyFetchState`, `selectItemBodyFetchState`, lane-census tag),
`index/item-store-body.test.ts`.

- Add `hasBody: boolean` (`body IS NOT NULL`). Notion's skip reads it too (same defect), with a
  test that a stripped page is fetched again. Update the two `toEqual`
  expectations; add a test that a NULLed body (what a `metadata_only` reindex does) reads
  `hasBody: false` with the verdict still present.
- Lane-census tag becomes `scope=page,doc service=notion,google_drive`; run `bun run audit:lane-census --check`.

## Task 5 — Drive writes Docs as `doc` with text

Files: `connectors/google-drive-sync.ts`; tests in a new `src/connectors/google-drive-docs.test.ts`
(StubFetch, no `mock.module`, so a `src` run loads it) — the fixture is the Drive v3 `files` shape the
real writer reads.

1. `writeDriveFile(deps, f)` (async) replaces `upsertDriveFile`: non-Docs exactly as before; a Doc is
   skipped when `bodyFetchState` shows a verdict, a body and the same `modifiedAt`; otherwise exported
   (`fetchGoogleText`, `files/{id}/export?mimeType=text/plain`) unless depth is `metadata_only`, and
   written as `type: "doc"` with `body` (+ `bodyTruncated` when over `BODY_MAX_PROSE`), verdict
   `bodyFetch` only at `full`; without text it writes `bodyPreview` like a file.
2. Per-call `DocExportBudget` (200). Budget exhausted (not at metadata_only) or a transient failure
   (429, 5xx, no status) sets `rearm`. 401 rethrows; anything else logs a warning and indexes the Doc
   without text.
3. `applyChange`/`countAppliedDriveChanges`/the init list are async over `writeDriveFile`; counts are
   rows actually written (a current Doc is not counted).
4. Tests:
   - a changed Doc is exported and stored as `doc` with its text, `bodyFetch: "complete"`, same id as
     a pre-existing `file` row for that Drive id (re-typed, one row);
   - unchanged revision with a body → no export call; NULLed body → exported again;
   - PDFs/images still `file` with `mimeType`/`size` (media pipeline input unchanged);
   - over 16,384 chars → `capped`, `body_complete = 0`;
   - `metadata_only` depth → no export call, row is `doc` with an empty body;
   - `summary` depth → exported, no verdict;
   - 403 → row without text, no verdict, sync succeeds; 429 → same and the re-list is re-armed;
     401 → the sync throws `UnauthenticatedError`;
   - BOM never reaches `item.body`.

## Task 6 — The one-time re-list on the `delta` cursor

Files: `connectors/google-drive-sync.ts`; tests as Task 5.

1. `DriveDocsRelist = { listToken } | { doneAt: depth }`; `decodeDriveDeltaPayload` reads `docs`
   (unreadable → absent); `docs` is preserved on delta continuation cursors.
2. After a caught-up delta page: `docs` absent, re-armed, or `doneAt` ≠ run depth → run
   `runDocsRelist` from the start (or resume `listToken`): list `mimeType = '<doc>' and trashed =
   false` pages while ≥100 exports remain and at most `DOCS_RELIST_PAGES_PER_SYNC` (5) pages per call
   (a page of current Docs spends no export, so the budget alone does not bound it); write only Docs already indexed or modified inside the
   30-day window; a transient failure inside the re-list does not re-arm; `doneAt: depth` when the
   listing ends. `hasMore` is true while the re-list is unfinished.
3. Drain ends with a delta cursor WITHOUT `docs`, so the first delta call re-lists.
4. Update the four existing tests that pin a delta cursor or a call count to pass
   `docs: { doneAt: "full" }` (they test other behaviour); give the shared sync harness context
   `depth: "full"` (it had none, which no scheduler run ever produces).
5. Tests:
   - an upgraded cursor (`delta` without `docs`) re-lists: an old `file` row for a Doc becomes `doc`
     with text; a never-indexed Doc older than the window is NOT written; a recent one is;
   - re-list resumes from `listToken` across calls, ends `{ doneAt: "full" }`, `hasMore` false;
   - a call whose changes page used >100 exports does not start a re-list page (`listToken` kept);
   - `doneAt: "summary"` under a `full` run re-arms;
   - a 429 during a delta page re-arms a finished re-list.

## Task 7 — PM pack 1.1.0

Files: `packs/bundled/pm.json`, `packs/bundled-packs.test.ts`, any test pinning pm `1.0.0` that is
about the CURRENT bundled pack (re-derive with `git grep -n '"1.0.0"'` near `pm`; fixtures that
build their own 1.0.0 record stay).

- `version: "1.1.0"`; defaults gain `\n[sources]\nmap = ["google_drive:doc=doc"]\n`.
- Test: pm is 1.1.0, `checkPackFragment` accepts it and its `sources.map` list parses to that entry;
  `resolveSourceMapping` over a snapshot with the pm layer puts `google_drive:doc` in the decisions
  and glossary effective sets as kind `doc`.

## Task 8 — Done-when proof: a decision in a Doc is mined

File: a test beside the existing PR 2a mapping tests (`decisions/` — pick the one that runs the pass
over a real migrated DB with a `[sources]` layer, e.g. the `decision-corroborate.test.ts` /
pass tests that already use `map = [...]`).

- Index a `google_drive:doc` row through the REAL writer path (`upsertIndexedItemForSync`) with a
  decision sentence; with the PM 1.1.0 defaults as the pack layer, the decisions pass's candidate
  scan (effective set) selects it; without the layer it does not.

## Task 9 — Docs

- `packages/docs/src/content/docs/connectors/google-drive.mdx`: Docs are indexed with their text
  (plain-text export, up to 16,384 characters, only new or changed Docs, 200 per sync), other files
  metadata only; a one-time re-list after upgrade.
- `docs/CHANGELOG.md`: dated entry at the top of Post-Phase-6.
- Skills: `.claude/commands/nimbus-embedding-routing.md` (if it enumerates `PROSE_HEAVY_TYPES`, add
  the entry) and `nimbus-index-body-depth.md` (Drive `doc` declared-full; stays out of rebody, mixed).
- `docs/cli-reference.md` role-pack doctor example already says `pm 1.0.0 -> 1.1.0` — now true.
- Run `bun run audit:doc-refs` and `bun run audit:status-drift`.

## Verification before the PR

`bun run preflight:fast`, `bun run typecheck:tests` (0 new), whole `bun test packages/gateway/src`,
`bun test scripts`, `bun test packages/gateway/test/unit/connectors/google-drive-sync.test.ts`
(the `test/` tree is not loaded by a `src` run; the new Docs tests are under `src/`). Full-suite runs take the shared lock.
