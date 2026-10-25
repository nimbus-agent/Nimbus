# Role packs P2 PR 2b — source mappings, glossary side — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The glossary follows the effective source mapping that PR 2a built. Newly mapped types are caught up, terms from unmapped types are hidden (from reads, counts, search, the tour and the fleet sweep) without being demoted or deleted, and a term mined from a local-only source is embedded locally.

**Architecture:** PR 2a's catch-up module moves to `sources/` and gains the `glossary` pass. Statistics stored on `glossary_term` are computed over the **known** set (built-ins plus every type with a catch-up row), so a mapping change never rewrites a row. Reads, the pending queues and projection use the **effective** set. One module, `glossary/glossary-visibility.ts`, decides whether a term is visible and how it is projected. Every projection goes through it, so the hiding rule and the § 7.1 routing rule live in one place. When the known set is a subset of the effective set (the default: no exclusions, nothing removed), every term is visible and stored statistics are already effective. A fast path then skips every per-term FTS check, so a user with no `[sources]` config pays nothing.

**Tech Stack:** Bun + TypeScript strict, `bun:sqlite` FTS5, `bun test`.

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md` §§ 6, 7 (glossary half), 7.1, 9 item 2 (+ `-review.md`). On `dev/asaf/role-packs` only. PR 2a is merged as `50391fb5`. It provides `sources/source-mapping.ts`, V74 `source_catchup_state` (its `pass` CHECK already admits `'glossary'`), `decisions/decision-catchup.ts`, and `idx_item_service_type_modified`.

## Global Constraints

- **Branch and worktree:** branch `dev/asaf/role-packs-p2-glossary` from `origin/main`. Create the worktree by ABSOLUTE path: `git worktree add C:/gitrep/Nimbus/.claude/worktrees/role-packs-p2-glossary -b dev/asaf/role-packs-p2-glossary origin/main`. Never commit on `main`, and never put `docs/superpowers/**` on the branch. Verify the branch before every commit.
- **Migrations:** no schema migration. V74 already holds everything; the visibility fingerprint lives in memory (Task 3 ruling).
- **Nothing is rewritten:** nothing in `glossary_term` is deleted or rewritten by a mapping change. A hidden term keeps its row, status, stats and definition.
- **Never hidden:** manual and agent-accepted terms (`definition_source` `manual` / `agent`) are never hidden by the mapping. Agent terms stay never projected (unchanged).
- **§ 7.1:**
  - A term's search copy embeds remotely only if every contributing type (the distinct `service:type` of its FTS occurrences over the **known** set) is remote-eligible: in `PROSE_HEAVY_TYPES`, or a built-in table type (`builtinSourceEntries()`).
  - Any other contributing type makes the term local-only: it is projected as `nimbus:glossary_term_local`, which is in `LOCAL_ONLY_PROSE_TYPES` and not in `PROSE_HEAVY_TYPES` (the routing disjointness test still guards it).
  - A term is projected under exactly one of the two types at a time.
- **Liveness:** passes resolve the mapping per run (`sourceMappingFor(configDir)`, plus a live `mappingAt` re-read between catch-up batches, as in 2a); reads resolve it per call. No boot snapshot.
- **Code rules:** I9 bound params for every dynamic `IN`; I14 writes through `dbRun`/`dbExec`; no `any`; no circular imports (`audit:boundaries`).
- **Example names:** never use `readwise` in a production example or comment (`scripts/structure-audit/readwise-unbundled.acceptance.test.ts` allows it in three files only). Use `ext_notes:highlight`.
- **Verification before the PR:** run `bun run preflight:fast`, `bun run typecheck:tests` (0 new), the WHOLE `bun test packages/gateway/src`, AND `bun test scripts` (the readwise test lives there).
- **PR title:** `feat(glossary): role packs and your config choose which sources glossary terms come from`. No `!`.

## Review Focus

1. **An owner excludes `slack:message`, and a term's only occurrences are in Slack.** It disappears from `nimbus glossary` (list, term lookup, near-miss suggestions, counts), from `nimbus ask` (unprojected), from the `wow` tour and from a fleet `terms` sweep. Its row is still `consolidated`, with unchanged stats. Removing the exclude brings it back and re-projects it with no model call (Tasks 3, 4).
2. **A term that occurs in Slack and Jira under the same exclude.** It stays visible, its displayed `docFreq`/`serviceSpread`/top sources count Jira only, and the stored row is untouched (Task 4).
3. **A pack adds `ext_notes:highlight=note`, and a term occurs in highlights and Jira.** Its search copy is `nimbus:glossary_term_local`, and no `nimbus:glossary_term` item exists for it. When the pack is removed and reconcile re-checks the term, it goes back to `nimbus:glossary_term` (Task 3).
4. **No `[sources]` anywhere (the default).** The list, the counts, the pass and projection behave exactly as on `main`: existing glossary tests pass unmodified apart from adding `mapping: BUILTIN_SOURCE_MAPPING`, and the fast path issues no per-term FTS query (Tasks 2–4).
5. **`--rebuild` with an exclude in force.** Terms come back consolidated or pending as on `main`. Hidden ones are not projected, and the catch-up cursors for the `glossary` pass are cleared (Tasks 2, 3).

---

### Task 1: The shared catch-up module and the known set

**Files:**
- Move: `decisions/decision-catchup.ts` → `sources/source-catchup.ts`, and `decisions/decision-catchup.test.ts` → `sources/source-catchup.test.ts`. Update the importers: `decisions/decision-extract.ts` and its tests.
- Modify: `glossary/glossary-store.ts` (`computeTermStats` :105), `glossary/glossary-source-types.ts`

**Interfaces:**
- Produces:
  - `sources/source-catchup.ts`: `export type CatchupPass = "decisions" | "glossary"`. Everything else is moved verbatim (`reconcileCatchupRows`, `catchupTypes`, `runCatchup`, `CatchupCursor`, `CatchupType`, `CatchupRun`, `CatchupSummary`).
  - `export function knownSourceTypes(db: Database, pass: CatchupPass): readonly string[]` — the built-in types for the pass (`sourceTypesFor(pass)`, in table order), then every other `service_type` with a `source_catchup_state` row for that pass, in `service_type` order. Frozen.
  - `export const CATCHUP_SCAN_SQL` moves here unchanged too, because the glossary needs the same seek. Its column list must cover both passes' `ScanRow`: id, service, type, title, body, body_complete, modified_at.
  - `glossary-store.ts`: `computeTermStats(db, termKey, types: readonly string[]): TermStats` — the source set becomes a parameter, built with `sourceFilterSql(types, "i")`. `TermStats` gains `contributingTypes: readonly string[]` (distinct `service:type` over the same match, sorted).
  - `glossarySourceFilter()` and `GLOSSARY_SOURCE_TYPES` are deleted. Remove them if nothing outside tests imports them; if the I28 test or `source-kinds.test.ts` pins `GLOSSARY_SOURCE_TYPES`, keep that constant only.
  - `types` is REQUIRED, with no default. Typecheck finds every caller. The known test callers are `glossary-store.test.ts`, `glossary-extract.test.ts`, `glossary-manual.test.ts`, `glossary-reconcile.test.ts`, `mcp-sink/capture-native.test.ts`, `mcp-sink/capture-gate.test.ts`, `agents/_lib/tour-selectors.test.ts`, `fleet/fleet-sweep-enumerators.test.ts` and `fleet-sweep-enumerators.coverage.test.ts`. Each passes `sourceTypesFor("glossary")`.

- [ ] **Step 1: Tests.**
  - `source-catchup.test.ts`: the moved tests pass unchanged. Add a test that `reconcileCatchupRows(db, "glossary", …)` and the `decisions` rows do not interact: each pass's rows are keyed by pass.
  - `knownSourceTypes`:
    - with no rows it equals `sourceTypesFor("glossary")`;
    - after a `glossary` row for `ext_notes:highlight` it ends with that type;
    - a `decisions`-only row is not included.
  - `computeTermStats`:
    - with the built-in glossary types it equals today's result for the existing fixtures;
    - with `types = []` it returns `docFreq 0` and `contributingTypes []`, never `IN ()`;
    - `contributingTypes` lists `jira:issue` and `slack:message` for a term in both.
- [ ] **Step 2: Run** `bun test packages/gateway/src/sources packages/gateway/src/glossary packages/gateway/src/decisions` → FAIL.
- [ ] **Step 3: Implement.**
  - Update every `computeTermStats` caller so behaviour is unchanged for now: pass `sourceTypesFor("glossary")`. The callers are discover, reconcile, manual and `mcp-sink/capture-native.ts:161`. Task 2 switches the pass callers to the known set.
- [ ] **Step 4: Run** the same command → PASS. Then run `bun run typecheck` and `bun run audit:boundaries`.
- [ ] **Step 5: Commit** `refactor(sources): share the catch-up cursors between passes; term stats take a source set`.

---

### Task 2: The glossary pass follows the mapping

**Files:**
- Modify:
  - `glossary/glossary-extract.ts`: `GlossaryPassOptions` :38, `scanDelta` :152, `loadGlossaryCandidates` :201, `discoverPhase` :224, `selectConsolidationWork` :302, `rebuildGlossary` :545.
  - `glossary/glossary-store.ts`: `selectPendingBatch` :237, `selectSnippetUpgradeBatch` :295, `clearGlossary` :568.
  - `glossary/glossary-reconcile.ts`.
  - `glossary/glossary-manual.ts` (its `computeTermStats` call).
  - `platform/assemble.ts` (the glossary `passOpts` near :782).
  - `demo/seed.ts:408`.
  - `mcp-sink/capture-native.ts:161`.
- Test: `glossary-extract.test.ts`, `glossary-store.test.ts`, `glossary-reconcile.test.ts` (ADD).

**Interfaces:**
- Consumes (Task 1): `knownSourceTypes`, `reconcileCatchupRows`, `catchupTypes`, `runCatchup`, `CATCHUP_SCAN_SQL`, and `computeTermStats(db, key, types)`. From 2a: `SourceMapping`, `BUILTIN_SOURCE_MAPPING`, `sourceMappingFor`, `sourceFilterSql`.
- Produces:
  - `GlossaryPassOptions.mapping: SourceMapping` (REQUIRED) and `mappingAt?: () => SourceMapping`.
  - `loadGlossaryCandidates(db, { sinceMs, mapping })`, with `mapping` required. In this task `agents/glossary.ts:176` passes `BUILTIN_SOURCE_MAPPING`; Task 4 switches it to `ctx.mapping`.
  - `selectPendingBatch` / `selectSnippetUpgradeBatch` gain a required `sets: { effective: readonly string[]; fast: boolean }` argument. Typecheck finds the callers, including `glossary-resume.test.ts` and `glossary-store.test.ts`.
  - `export function hasEffectiveOccurrence(db: Database, termKey: string, effective: readonly string[]): boolean` in `glossary-store.ts`: an FTS `EXISTS … LIMIT 1` over the effective set, false for an empty set.
  - `export function isFastPath(known: readonly string[], effective: readonly string[]): boolean` in `glossary/glossary-visibility.ts` (a new file, which Task 3 extends): true when every known type is effective.

**Rules:**
- **Run start:** `reconcileCatchupRows(db, "glossary", mapping.typesFor("glossary"), new Set(sourceTypesFor("glossary")), mainCursor)`, in its own transaction, where `mainCursor` is the `glossary_pass_state` cursor.
- **Catch-up** runs before the delta scan through `runCatchup`:
  - `maxBatches` is `GLOSSARY_CATCHUP_BATCHES = 4` per pass. The glossary has no multi-batch loop today, so catch-up gets its own small budget; the delta scan keeps its single batch.
  - `batchLimit` is `SCAN_BATCH_LIMIT`, and `isEffective` reads `mappingAt()`.
  - `mine` collects the batch's terms with `mineTerms`, then upserts each candidate exactly as `discoverPhase` does: stats over the KNOWN set, the `minDocFreq` floor, `scoreTerm`. It runs inside `runCatchup`'s transaction and returns the number upserted.
  - Catch-up never writes `glossary_pass_state`. Its `scanned`/`discovered` counts are added to the delta's in the pass summary and in `writePassState`'s `lastPassNew`/`scannedItems`, as the decisions pass does. The watermark comes from the delta scan alone.
- **Delta scan:** `scanDelta` uses `sourceFilterSql(mapping.typesFor("glossary"), "i")`.
- **Stored stats:** discover, catch-up, reconcile, manual and `capture-native` compute stored stats with `knownSourceTypes(db, "glossary")`. So removing a mapping never demotes a term, and re-adding never re-consolidates it. In `capture-native` the db has no mapping context, but the known set needs none.
- **Queues:** `selectPendingBatch` and `selectSnippetUpgradeBatch` take `{ effective, fast }`. On the fast path SQL is unchanged. Otherwise they over-fetch (`limit × 4`, capped at `NEAR_MISS_POOL`), drop rows where `definition_source` is not manual/agent and `hasEffectiveOccurrence` is false, then slice to `limit`. Dropped rows stay `pending`, with no attempt recorded.
- **`clearGlossary`** also runs `DELETE FROM source_catchup_state WHERE pass = 'glossary'`.
- **`assemble.ts`** builds `mapping: sourceMappingFor(paths.configDir)` and `mappingAt` on every run, as the decisions pass does. **`demo/seed.ts`** passes `BUILTIN_SOURCE_MAPPING` (2a's ruling).

- [ ] **Step 1: Tests** (each file's real-SQLite helpers):
  - `a newly mapped type's existing items become glossary candidates`. A term present only in `ext_notes:highlight` items (doc freq ≥ `minDocFreq`) is not a candidate under the built-in mapping. After a run with `ext_notes:highlight=note` it is a `pending` candidate.
  - `built-in types are not re-scanned on upgrade`: the first run inserts `done = 1` glossary rows at the main cursor, and the main cursor ends where a run on `main` would leave it.
  - `catch-up never moves the glossary main watermark`. Check it from `mappingAt` between catch-up batches, as 2a's decisions test does, so a rewind cannot hide behind the end-of-run write.
  - `removing a mapping never demotes a term`. A consolidated term mined from Jira and `ext_notes:highlight`; the pack is removed; reconcile runs past its cooldown. The term is still `consolidated`, and its stored `doc_freq` still counts the highlights.
  - `exclude keeps a Slack-only pending term out of the model batch`: with `slack:message` excluded, `selectPendingBatch` skips it, and it is still `pending` with `attempts` unchanged.
  - `fast path issues no FTS existence check`: with the built-in mapping, spy on `hasEffectiveOccurrence` (inject it or count calls) → 0 calls.
  - `rebuild clears glossary catch-up cursors`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `bun test packages/gateway/src/glossary packages/gateway/src/sources packages/gateway/src/mcp-sink packages/gateway/src/demo packages/gateway/src/platform` → PASS. Then run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(glossary): the pass mines the effective source mapping and catches up new types`.

---

### Task 3: Visibility, projection and the § 7.1 routing rule

**Files:**
- Modify:
  - `glossary/glossary-visibility.ts` (extend).
  - `glossary/glossary-project.ts` (`projectTerm` :40, `unprojectTerm` :76).
  - `embedding/routing.ts` (`LOCAL_ONLY_PROSE_TYPES`).
  - Every `projectTerm` caller moves to the chokepoint: `glossary-extract.ts:401`, `glossary-reconcile.ts:90` and `glossary-manual.ts:161`. The rebuild loop at `glossary-extract.ts:555` calls `unprojectTerm` and stays as it is. The test callers of `projectTerm` (`glossary-project.test.ts`, `glossary-extract.test.ts:528`, `glossary-reconcile.test.ts:57`, `capture-native.test.ts:115`) pass the new required `itemType`.
  - `mcp-sink/capture-native.ts:181` keeps `unprojectTerm`, which is unchanged: there is one item id for either type.
- Test: `glossary-visibility.test.ts` (new), `glossary-project.test.ts`, `embedding/routing.test.ts`.

**Interfaces:**
- Produces (`glossary-visibility.ts`):
  - `export type GlossarySets = { readonly effective: readonly string[]; readonly known: readonly string[]; readonly fast: boolean }`.
  - `export function glossarySets(db: Database, mapping: SourceMapping): GlossarySets`.
  - `export function isTermVisible(db: Database, term: GlossaryTerm, sets: GlossarySets): boolean`. It is true for manual/agent rows and on the fast path; otherwise it returns `hasEffectiveOccurrence`.
  - `export function routesRemotely(contributingTypes: readonly string[]): boolean`. It is true iff every type is in `PROSE_HEAVY_TYPES` or in `builtinSourceEntries()` keys, and true for an empty list (a manual term with no occurrences stays on today's type).
  - `export function syncTermProjection(db: Database, termKey: string, sets: GlossarySets, nowMs: number): "projected" | "projected_local" | "unprojected" | "skipped"`. This is the ONE place a term's search copy is written:
    - It reads the row and skips agent rows and rows with no definition.
    - A term that is not `consolidated` or not visible is unprojected.
    - Otherwise it calls `computeTermStats(db, key, sets.known)` for `contributingTypes` and chooses the type with `routesRemotely`. This routing check is NEVER skipped by the fast path: the fast path is about visibility, not routing.
    - Both types share ONE item id, `nimbus:glossary:<termKey>`, because `itemPrimaryKey` ignores `type` and `upsertIndexedItem`'s `ON CONFLICT(id)` would rewrite `type` in place. So when the existing item's type differs from the chosen one, it DELETEs the row and then upserts, in one transaction, so that the old type's vectors are dropped with the row (the V30 delete triggers) instead of surviving under a re-typed item. When the type matches, it just upserts.
  - `export function sweepProjections(db: Database, sets: GlossarySets, nowMs: number): { projected: number; unprojected: number }`. It runs in ONE `db.transaction`, gated by an in-memory `WeakMap<Database, string>` fingerprint of `sets.effective` plus `sets.known`:
    ```ts
    if (fingerprint unchanged) return { projected: 0, unprojected: 0 };
    targets = sets.fast
      ? consolidated non-agent terms with NO item (single anti-join)
      : every consolidated non-agent term;
    for (const key of targets) syncTermProjection(db, key, sets, nowMs); // always routes
    ```
    The first pass after a boot always sweeps.
  - `discoverPhase` and catch-up call `syncTermProjection` for every mined key that is already `consolidated`. Those terms gained occurrences this pass, so their visibility (a hidden term whose new item is in an effective type) and their routing (a new local-only contributor) are refreshed immediately instead of waiting for the reconcile cooldown.
- `glossary-project.ts`: `projectTerm(db, term, nowMs, itemType: "glossary_term" | "glossary_term_local")`, with `itemType` required. `unprojectTerm` is unchanged: one id covers either type.
- `routing.ts`: `LOCAL_ONLY_PROSE_TYPES` gains `"nimbus:glossary_term_local"` with a comment citing spec § 7.1.

**Rulings:**
- The § 7.1 rule applies to every projected term, manual ones included. A manual definition's metadata carries `topSources` titles from local-only items, so it gets the same rule.
- The sweep fingerprint is kept in memory, not in the schema, so there is no migration. The cost is one full sweep per gateway boot, and the fast path makes that sweep a single query for the default user.
- Each glossary pass calls `sweepProjections` once at the end of `discoverPhase`, after reconcile.

- [ ] **Step 1: Tests.**
  - `routesRemotely`:
    - `["jira:issue","slack:message"]` → true;
    - `["jira:issue","ext_notes:highlight"]` → false;
    - `["zoom:transcript"]` (PROSE_HEAVY, not built-in) → true;
    - `["nimbus:web_clip"]` → false;
    - `[]` → true.
  - `a local-only contributor projects the term as glossary_term_local`: exactly one item exists, of type `glossary_term_local`, and a `glossary_term` item does not.
  - `routing flips back when the contributor leaves the known set`: the catch-up row is deleted to simulate a rebuild, then reconcile runs → the term is projected under `glossary_term` and the local item is gone.
  - `a hidden term is unprojected and re-projected without a model call`. Exclude `slack:message` on a Slack-only consolidated term, run a pass → no item, and the row is unchanged (`status`, `definition`, `doc_freq`). Remove the exclude and run a pass → the item is back, and the fake LLM was called 0 times.
  - `manual terms are never hidden`.
  - `sweep is a no-op when the effective set is unchanged`: the second pass calls `syncTermProjection` 0 times.
  - `routing.test.ts`: the disjointness test covers the new key, and `nimbus:glossary_term_local` routes local.
  - `a routing flip drops the old vectors`: seed a remote-routed term with a row in `vec_items_1536`, flip it to local → no `vec_items_1536` row remains for that item id.
  - `the fast path still routes`: with no exclusions but a pack mapping `ext_notes:highlight=note` (known ⊆ effective), a newly consolidated term with a highlight occurrence is projected as `glossary_term_local`.
  - `a term that gains a local-only occurrence is re-routed in the same pass`: a remote-projected term; a new `ext_notes:highlight` item mentioning it is synced; one pass → its item type is `glossary_term_local`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `bun test packages/gateway/src/glossary packages/gateway/src/embedding packages/gateway/src/mcp-sink` → PASS. Then run `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(glossary): hidden terms leave search, and a term from a local-only source embeds locally`.

---

### Task 4: Glossary reads hide unmapped terms

**Files:**
- Modify:
  - `glossary/glossary-store.ts` (`listConsolidated` :362, `countByStatus` :461).
  - `agents/glossary.ts`:
    - `GlossaryContext` :27 gains `mapping: SourceMapping` (required).
    - List mode :195.
    - Term mode `resolveTerm` :70/:74 and the near-miss pool :233.
    - `countByStatus` :171 and `loadGlossaryCandidates` :176.
  - `ipc/agents-rpc.ts` (~:990, where the glossary context is built).
  - `agents/_lib/tour-selectors.ts` :172.
  - `fleet/fleet-sweep-enumerators.ts` :141 (`enumerateTerms`; `SweepSources` gains `mapping: () => SourceMapping`).
  - `platform/assemble.ts` :3373 (passes `mapping: () => sourceMappingFor(paths.configDir)`).
- Test: `agents/glossary.test.ts`, `glossary-store.test.ts`, `tour-selectors.test.ts`, `fleet-sweep-enumerators.test.ts` (ADD).

**Interfaces:**
- Consumes: `glossarySets`, `isTermVisible`, `computeTermStats(db, key, types)`.
- Produces:
  - `export function listVisibleConsolidated(db: Database, limit: number, sets: GlossarySets, opts: { recomputeStats: boolean }): GlossaryTerm[]`.
    - Fast path → `listConsolidated(db, limit)` unchanged.
    - Otherwise it pages in `listConsolidated` order with a deterministic tiebreaker added (`ORDER BY (definition_source = 'manual') DESC, score DESC, term_key ASC LIMIT ? OFFSET ?`; add the same `term_key ASC` to `listConsolidated` itself) in pages of `max(limit, 50)`, until `limit` visible rows or the table is exhausted.
    - With `recomputeStats`, each visible mined row's `docFreq`, `serviceSpread` and `topSources` are replaced by `computeTermStats(db, key, sets.effective)` (display only, never written). The near-miss pool passes `recomputeStats: false`, since it uses keys only.
  - `export function effectiveView(db: Database, term: GlossaryTerm, sets: GlossarySets): GlossaryTerm` — the same display-only recompute for ONE term (identity on the fast path and for manual/agent rows). Term mode passes its resolved term through it.
  - `countByStatus(db, sets: GlossarySets)`. On the fast path SQL is unchanged. Otherwise `total` counts visible consolidated rows: manual and agent rows plus mined rows with an effective occurrence. `pending` and `vetoed` stay whole-table (Ruling below).
- **Term mode:** a resolved term that is not visible is a miss, with the near-miss suggestions drawn from `listVisibleConsolidated(db, NEAR_MISS_POOL, sets, { recomputeStats: false })`. A visible one is shown through `effectiveView`.
- **Read cost, slow path only:** `countByStatus` runs one `hasEffectiveOccurrence` (`EXISTS … LIMIT 1`) per consolidated mined term. Add a test that seeds 500 consolidated terms with one type excluded and asserts `countByStatus` completes in under 2 s locally. Record the measured time in the report. The fast path issues none of these queries.
- **The tour's "has a glossary" check and `enumerateTerms`** use visible consolidated terms.
- **Ruling:** `pending`/`vetoed` counts are not filtered. They are queue bookkeeping, and filtering them would cost one FTS query per queued term on every brief. The hidden-term rule applies to terms a user reads. Cost if wrong: the brief's pending count includes terms waiting on an excluded source.

- [ ] **Step 1: Tests:**
  - `an excluded source's only term is hidden from list, term lookup, near misses and the count`: a Slack-only consolidated term with `slack:message` excluded; then re-included → visible again. The `glossary_term` row is unchanged throughout.
  - `a term in two services shows effective stats only`: Slack and Jira occurrences, Slack excluded → the entry's `docFreq` counts Jira only, in BOTH list mode and term mode, and the stored `doc_freq` is unchanged.
  - `paging with tied scores returns each visible term once`: 120 consolidated terms with one score, every third one hidden, `limit: 60` → 60 distinct keys.
  - `limit counts visible terms`: the 3 hidden terms have the HIGHEST scores; with `limit: 2` the 2 visible ones come back.
  - `manual and agent terms are never hidden`.
  - `the wow tour and the fleet terms sweep skip hidden terms`.
  - `default mapping output is unchanged`: the existing `agents/glossary.test.ts` expectations pass with `mapping: BUILTIN_SOURCE_MAPPING`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `bun test packages/gateway/src/glossary packages/gateway/src/agents packages/gateway/src/fleet packages/gateway/src/ipc` → PASS.
- [ ] **Step 5: Commit** `feat(glossary): nimbus glossary shows only terms from currently mapped sources`.

---

### Task 5: Prompt line, docs, verification, PR

**Files:**
- Modify:
  - `packs/pack-prompt.ts`: in the `Sources added:` section (2a), when any added entry is not remote-eligible (`routesRemotely([serviceType])` false), add a line after the entries: `  glossary terms mined from these sources are embedded on this machine only`.
  - `docs/cli-reference.md`: the `[sources]` section; drop "decisions only until the glossary follows in a later release".
  - `docs/CHANGELOG.md`.
  - `docs/architecture.md` (§ Source kinds: known vs effective sets, visibility, the second projection type).
  - `.claude/commands/nimbus-implicit-knowledge-extraction.md` (checklist step 5: the glossary is now caught up too).
  - `.claude/commands/nimbus-embedding-routing.md`, if it enumerates `LOCAL_ONLY_PROSE_TYPES`.
- Test: `pack-prompt.test.ts`: `ext_notes:highlight=note` → the local line is present; a pack adding only `zoom:transcript` → no line.

- [ ] **Step 1:** Write the prompt test, run it RED, implement, run it GREEN.
- [ ] **Step 2:** Edit the docs. Re-grep the restatements: `git grep -n "decisions only\|glossary is unchanged\|LOCAL_ONLY_PROSE_TYPES\|glossary_term" -- docs .claude/commands CLAUDE.md GEMINI.md`. Fix every one that this PR makes false.
- [ ] **Step 3: Verify.** Each of these must pass, unless noted:
  - `bun run preflight:fast`
  - `bun run typecheck:tests` (0 new)
  - `bun test packages/gateway/src` (0 fail)
  - `bun test scripts` (0 fail)
  - `bun test packages/cli` (0 fail)
  - the local lcov and `audit:coverage-floor`, run for the new files only and recording the result honestly (CI Linux is authoritative)
  - `git diff origin/main --stat -- docs/superpowers` (empty)
- [ ] **Step 4:** Commit, push, and run `gh pr create` with the Global Constraints title. The body states the rulings, the fast path, and that a hidden term keeps its row. End it with the attribution line. Check CodeRabbit threads after each push.
