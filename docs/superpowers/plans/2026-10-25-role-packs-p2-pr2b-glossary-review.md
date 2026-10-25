<!-- Reviewer: Google Antigravity CLI (agy, plan mode, read-only file snapshot of origin/main 50391fb5). -->
# Review of Implementation Plan: `role-packs-p2-pr2b-glossary.md`

### 1. Fast-Path Condition Bypasses § 7.1 Local-Only Embedding Routing
- **Severity:** Critical
- **Evidence:** 
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:90`: `isFastPath(known, effective)` returns true when every known type is effective.
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:143`: In `sweepProjections`, `"On the fast path it projects only the consolidated non-agent terms with no item of either type, using a single anti-join."`
  - `packages/gateway/src/embedding/routing.ts:72-88`: `LOCAL_ONLY_PROSE_TYPES` enforces local-only embedding for privacy-sensitive types.
  - `plan/2026-10-25-role-packs-p2-source-mapping-design.md:251-263` (§ 7.1): A term's search copy embeds remotely *only if every contributing source type is itself remote-eligible*.
- **Problem:** If an owner adds a role pack or source mapping with a local-only source (e.g. `ext_notes:highlight=note`) without exclusions, `known ⊆ effective` evaluates to `true` once catch-up records the row. Because `isFastPath` is `true`, `sweepProjections` takes the fast path and blindly inserts unprojected terms as default `nimbus:glossary_term` (or leaves existing `nimbus:glossary_term` items alone), completely bypassing `routesRemotely(contributingTypes)`. Mined text from local-only sources is thus leaked to remote OpenAI embedding.
- **Fix:** Distinguish between read/visibility fast-path and projection routing fast-path. In `glossary-visibility.ts`, define `isProjectionFastPath(known: readonly string[], effective: readonly string[]): boolean` which requires `isFastPath(known, effective)` **and** that every type in `known` is remote-eligible (`routesRemotely([type])` is true). If any known type is local-only, `sweepProjections` must run `syncTermProjection` to route items correctly.

---

### 2. In-Memory Sweep Fingerprint Misses Catch-Up and Known Set Changes
- **Severity:** Critical
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:141-145`: `sweepProjections` is gated by `WeakMap<Database, string>` holding a fingerprint of `sets.effective`. A pass with an unchanged fingerprint does nothing.
  - `packages/gateway/src/glossary/glossary-extract.ts:224-282`: `discoverPhase` executes catch-up and delta scanning before calling `sweepProjections`.
  - `plan/2026-10-25-role-packs-p2-source-mapping-design.md:257-259`: Contributing types are computed over the **known** set and re-evaluated on each reconcile and re-projection.
- **Problem:** When an owner installs a pack adding a new source type, `sets.effective` reflects that new type immediately on pass 1, setting the fingerprint. However, catch-up runs over multiple passes (`GLOSSARY_CATCHUP_BATCHES = 4`). As subsequent passes scan items from the new source, existing terms acquire new occurrences from the new source. But on passes 2, 3, etc., `sets.effective` has **not** changed, so the fingerprint check skips `sweepProjections` entirely. Terms that acquired local-only contributors during catch-up batches are never switched from `glossary_term` to `glossary_term_local`.
- **Fix:** The sweep fingerprint must incorporate both `sets.effective` and `sets.known` (or catch-up completion state), e.g. `${effectiveKey}|${knownKey}|${catchupDone}`. Furthermore, if catch-up mined any rows in the current pass, `sweepProjections` must not be skipped.

---

### 3. False Assumption of Dual Item IDs Breaks Item Upsert and Deletion
- **Severity:** Critical
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:140`: `syncTermProjection` `"upserts that item and deletes the other type's item"`.
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:146`: `glossary-project.ts`: `"unprojectTerm deletes both item ids. The external id is unchanged; the item's type differs."`
  - `packages/gateway/src/glossary/glossary-project.ts:7-16, 76-80`: `SERVICE = "nimbus"`, `glossaryItemExternalId(termKey) = "glossary:" + termKey`. Primary key is `itemPrimaryKey(SERVICE, externalId)` = `"nimbus:glossary:" + termKey`.
  - `packages/gateway/src/index/item-store.ts:113-132`: `INSERT INTO item ... ON CONFLICT(id) DO UPDATE SET type = excluded.type, ...`
- **Problem:** `item.id` is strictly `service:external_id` (`nimbus:glossary:<termKey>`). It does not incorporate `type`. Therefore, both `glossary_term` and `glossary_term_local` share the **exact same primary key**. There are no "two item ids". If code performs `upsertIndexedItem` and subsequently executes `"deletes the other type's item"` using a query like `DELETE FROM item WHERE id = ? AND type = ?`, any mismatch in execution ordering or query structure risks deleting the row that was just upserted.
- **Fix:** Clarify in Task 3 that `nimbus:glossary:<termKey>` is a single primary key in table `item`. Changing routing simply calls `upsertIndexedItem(db, { service: "nimbus", type: itemType, externalId: ... })`, which atomically updates `item.type` in place via `ON CONFLICT(id)`. `unprojectTerm` needs only a single delete by `itemPrimaryKey("nimbus", glossaryItemExternalId(termKey))`, which deletes the row regardless of whether its `type` is `glossary_term` or `glossary_term_local`.

---

### 4. Task 2 Signature Change to `loadGlossaryCandidates` Breaks `agents/glossary.ts`
- **Severity:** Critical
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:88`: `loadGlossaryCandidates(db, { sinceMs, mapping })`, with `mapping` required.
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:114-115`: Task 2 step 4: `bun test ...` then `bun run typecheck`.
  - `packages/gateway/src/agents/glossary.ts:176`: `const candidates = loadGlossaryCandidates(ctx.db, { sinceMs: 0 });`
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:177, 181`: `agents/glossary.ts` is not modified until Task 4.
- **Problem:** Making `mapping` required on `loadGlossaryCandidates` in Task 2 causes `packages/gateway/src/agents/glossary.ts:176` to fail TypeScript compilation immediately (`TS2345: Property 'mapping' is missing`). Task 2 step 4 (`bun run typecheck`) will fail.
- **Fix:** In Task 2, make `mapping?: SourceMapping` optional in `loadGlossaryCandidates` (falling back to `BUILTIN_SOURCE_MAPPING` if undefined), or update `agents/glossary.ts:176` in Task 2 to pass `mapping: BUILTIN_SOURCE_MAPPING` until Task 4 wires live `ctx.mapping`.

---

### 5. Non-Deterministic `OFFSET` Paging in `listVisibleConsolidated`
- **Severity:** Critical
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:191`: `listVisibleConsolidated` pages `listConsolidated` order `(pages of max(limit, 50), by ORDER BY … LIMIT ? OFFSET ?)` until `limit` visible rows or the table is exhausted.
  - `packages/gateway/src/glossary/glossary-store.ts:365-367`: `SELECT * FROM glossary_term WHERE status = 'consolidated' ORDER BY (definition_source = 'manual') DESC, score DESC LIMIT ?`
- **Problem:** The sorting criteria `(definition_source = 'manual') DESC, score DESC` contains no unique tiebreaker column (such as `term_key`). In SQLite, rows with identical scores have non-deterministic ordering between queries. When paging with `LIMIT ? OFFSET ?`, rows with equal scores can shift positions between offset fetches, causing terms to be returned twice or skipped entirely.
- **Fix:** Ensure pagination query includes a deterministic tiebreaker: `ORDER BY (definition_source = 'manual') DESC, score DESC, term_key ASC LIMIT ? OFFSET ?`.

---

### 6. Unbounded FTS Costs on the Read Path (`countByStatus` and Near-Miss Pool)
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:191-195`: In `countByStatus`, `total` counts visible consolidated rows by checking effective occurrences. In `agents/glossary.ts:233`, near-misses fetch `listVisibleConsolidated(ctx.db, NEAR_MISS_POOL, sets)` with `NEAR_MISS_POOL = 500`.
  - `packages/gateway/src/agents/glossary.ts:171, 233`: `countByStatus` and near-misses run on brief generations.
  - `plan/2026-10-25-role-packs-p2-source-mapping-design.md:230-232` (§ 7): Display stats recomputed over effective set *for the listed terms only (bounded by the list size)*.
- **Problem:** 
  1. If `countByStatus` evaluates `hasEffectiveOccurrence` for every consolidated row in SQLite when not on the fast path, an index with 1,000 consolidated terms will execute 1,000 separate FTS queries on every brief request.
  2. For near-misses, calling `listVisibleConsolidated(db, 500, sets)` will execute `computeTermStats(db, key, sets.effective)` for up to 500 visible terms, even though `findNearMisses` only consumes `termKey` and discards all stats.
- **Fix:**
  1. For `countByStatus`, obtain visible consolidated count without per-term loops, or count terms having at least one item match via a single join/subquery or bounded approximation.
  2. Add an option `recomputeStats: boolean = true` to `listVisibleConsolidated`. Pass `recomputeStats: false` when invoked by the near-miss lane in `agents/glossary.ts:233`.

---

### 7. Missing Recomputation of Effective Stats in Term Mode Lookup
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:193`: `"Term mode: a resolved term that is not visible is a miss, with the near-miss suggestions drawn from listVisibleConsolidated(db, NEAR_MISS_POOL, sets)."`
  - `packages/gateway/src/agents/glossary.ts:70-76, 245-250`: `resolveTerm` returns `getTerm(db, key)` or `findBySynonym(db, key)`. `toEntry` maps the raw row directly to `GlossaryEntry`.
  - `plan/2026-10-25-role-packs-p2-source-mapping-design.md:229-232` (§ 7): Reads display `doc_freq`/`service_spread`/top sources recomputed over the effective set.
- **Problem:** Task 4 specifies replacing `docFreq`, `serviceSpread`, and `topSources` with `computeTermStats(db, key, sets.effective)` inside `listVisibleConsolidated` (list mode), but completely omits doing so for `resolveTerm` (term mode). When a user runs `nimbus glossary <term>` for a term present across multiple sources where one source is excluded, term mode will display stored (unfiltered) stats instead of effective stats, violating Review Focus 2.
- **Fix:** In `agents/glossary.ts`, when `resolveTerm` resolves a term that is visible and not on the fast path, recompute its `docFreq`, `serviceSpread`, and `topSources` using `computeTermStats(ctx.db, resolved.term.termKey, sets.effective)` before passing it to `toEntry`.

---

### 8. Missing Transaction Boundaries in `sweepProjections` and `discoverPhase`
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:144`: `sweepProjections` `"calls syncTermProjection for every consolidated non-agent term."`
  - `packages/gateway/src/glossary/glossary-extract.ts:224-282`: `discoverPhase` on `main` does not wrap candidate discovery in `db.transaction()`.
- **Problem:** If `sweepProjections` iterates through hundreds of terms calling `syncTermProjection` without an enclosing `db.transaction()`, SQLite will open and commit a separate transaction for every term. This causes severe disk I/O bottlenecks (fsync on every term) and risks leaving projection state half-updated if interrupted.
- **Fix:** Explicitly wrap the loop in `sweepProjections` in `db.transaction(() => { ... })()`.

---

### 9. Catch-Up Metrics Dropped from `glossary_pass_state`
- **Severity:** Important
- **Evidence:**
  - `packages/gateway/src/glossary/glossary-extract.ts:273-279`:
    ```ts
    writePassState(db, {
      watermarkMs: last?.modified_at ?? state.watermarkMs,
      watermarkId: last?.id ?? state.watermarkId,
      lastPassAt: opts.nowMs,
      lastPassNew: discovered,
      scannedItems: rows.length,
    });
    ```
  - `packages/gateway/src/decisions/decision-extract.ts:340-344, 355-357`: Accumulates `catchup.scanned` and `catchup.discovered` into `running.scanned` and `running.discovered`.
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:97-98`: Catch-up runs before delta scan; never writes `glossary_pass_state`.
- **Problem:** In `glossary-extract.ts`, `writePassState` writes `scannedItems: rows.length` and `lastPassNew: discovered`. If catch-up runs and mines terms, but `rows` (from `scanDelta`) is empty, `scannedItems` is recorded as 0 and `lastPassNew` only reflects `scanDelta`, silently discarding all catch-up progress from the pass summary and state.
- **Fix:** In `glossary-extract.ts` `discoverPhase`, initialize `scanned = catchup.scanned` and `discovered = catchup.discovered`, then accumulate delta scan counts into both before writing `writePassState`.

---

### 10. Erroneous Reference to Rebuild Loop `:555` as `projectTerm` Caller
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:127`: `"Every projectTerm caller, which moves to the chokepoint: glossary-extract.ts :401 and the rebuild loop :555, glossary-reconcile.ts :90, glossary-manual.ts :161."`
  - `packages/gateway/src/glossary/glossary-extract.ts:555`: `for (const key of listAllKeys(db)) unprojectTerm(db, key);`
- **Problem:** Line 555 in `glossary-extract.ts` calls `unprojectTerm`, not `projectTerm`. If the implementer replaces line 555 with `syncTermProjection`, `rebuildGlossary` will re-project terms instead of purging them prior to rebuilding.
- **Fix:** Remove `the rebuild loop :555` from the list of `projectTerm` callers moving to `syncTermProjection`. Line 555 remains `unprojectTerm(db, key)`.

---

### 11. Missing Test File `glossary-resume.test.ts` for `selectPendingBatch` Update
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:101`: `selectPendingBatch` and `selectSnippetUpgradeBatch` signature changes to take `{ effective, fast }`.
  - `packages/gateway/src/glossary/glossary-resume.test.ts:66, 85, 94, 100, 164`: Calls `selectPendingBatch(db, 10, QUEUE)`.
  - `callers-on-main.txt:153-158`: `glossary-resume.test.ts` imports and invokes `selectPendingBatch`.
- **Problem:** Task 2 does not list `packages/gateway/src/glossary/glossary-resume.test.ts` under modified files or test updates. Running `bun test` or `bun run typecheck` in Task 2 will fail on `glossary-resume.test.ts`.
- **Fix:** Add `packages/gateway/src/glossary/glossary-resume.test.ts` to Task 2 files and update its call sites to pass `{ effective: [...sourceTypesFor("glossary")], fast: true }`.

---

### 12. Missing Call Sites Across Codebase for `computeTermStats` Signature Change
- **Severity:** Important
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:50, 65`: `computeTermStats(db, termKey, types: readonly string[])` adds `types`. Task 1 only lists discover, reconcile, manual, and `capture-native.ts:161`.
  - `callers-on-main.txt:7, 8, 25-28, 65-66, 94, 103, 135, 144, 162-182, 194-195, 288-291, 294-299`:
    - `packages/gateway/src/agents/_lib/tour-selectors.test.ts:56`
    - `packages/gateway/src/fleet/fleet-sweep-enumerators.coverage.test.ts:70`
    - `packages/gateway/src/fleet/fleet-sweep-enumerators.test.ts:186`
    - `packages/gateway/src/mcp-sink/capture-gate.test.ts:689, 725`
    - `packages/gateway/src/mcp-sink/capture-native.test.ts:100, 180, 205`
    - `packages/gateway/src/glossary/glossary-extract.test.ts:953, 973`
    - `packages/gateway/src/glossary/glossary-manual.test.ts:350`
    - `packages/gateway/src/glossary/glossary-reconcile.test.ts:250`
    - `packages/gateway/src/glossary/glossary-store.test.ts:100, 121, 131, 135, 148, 153, 155, 181, 200, 205, 209, 388, 445`
- **Problem:** Task 1 step 4 requires `bun run typecheck` to pass. By changing `computeTermStats` to require `types: readonly string[]` without updating these test files, `typecheck` will fail across multiple packages (`agents`, `fleet`, `mcp-sink`, `glossary`).
- **Fix:** In Task 1, either provide a default parameter `types: readonly string[] = sourceTypesFor("glossary")` on `computeTermStats` during Task 1 (removing default in Task 2/4), or explicitly list and update all test callers in Task 1.

---

### 13. Missing Call Sites for `projectTerm` Signature Change
- **Severity:** Minor
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:146`: `projectTerm(db, term, nowMs, itemType: "glossary_term" | "glossary_term_local")`.
  - `callers-on-main.txt:54, 116-129, 136, 296`:
    - `packages/gateway/src/mcp-sink/capture-native.test.ts:115: projectTerm(db, t, NOW);`
    - `packages/gateway/src/glossary/glossary-extract.test.ts:528: projectTerm(db, seeded, 1);`
    - `packages/gateway/src/glossary/glossary-reconcile.test.ts:57: projectTerm(db, t, nowMs);`
    - `packages/gateway/src/glossary/glossary-project.test.ts:46, 58, 76, 77, 82, 92, 99`
- **Problem:** If `itemType` is a required 4th parameter on `projectTerm`, these existing tests in `capture-native.test.ts`, `glossary-extract.test.ts`, and `glossary-reconcile.test.ts` will fail type checking in Task 3.
- **Fix:** Default `itemType: "glossary_term" | "glossary_term_local" = "glossary_term"` on `projectTerm`, or add these test files to Task 3's modification list.

---

### 14. Internal Contradiction in `sweepProjections` Specifications
- **Severity:** Minor
- **Evidence:**
  - `plan/2026-10-25-role-packs-p2-pr2b-glossary.md:142-144`:
    - `"A pass with an unchanged fingerprint does nothing."`
    - `"On the fast path it projects only the consolidated non-agent terms with no item of either type, using a single anti-join."`
    - `"Otherwise it calls syncTermProjection for every consolidated non-agent term."`
- **Problem:** These bullets contradict each other: if a pass with an unchanged fingerprint does nothing, then on a normal subsequent pass (where fingerprint is unchanged), the fast-path anti-join query would never run.
- **Fix:** Rewrite the logic flow clearly:
  ```ts
  if (fingerprintUnchanged) return { projected: 0, unprojected: 0 };
  if (isProjectionFastPath) {
    // Single anti-join projecting unprojected consolidated terms as "glossary_term"
  } else {
    // Full sweep calling syncTermProjection for all consolidated terms
  }
  ```

---

## Disposition (plan author, 2026-10-25)

Every claim was checked against `origin/main` before the plan was changed.

| # | Finding | Disposition |
|---|---|---|
| 1 | The fast path skips § 7.1 routing | **Fixed.** Routing is never fast-pathed. The fast path only narrows which terms the sweep visits (those with no item), and each one still goes through `syncTermProjection`. New test: `the fast path still routes`. |
| 2 | The sweep fingerprint misses catch-up and known-set changes | **Fixed, by a different route than suggested.** The fingerprint now covers effective + known. The real gap was terms gaining occurrences mid-life: discover and catch-up now call `syncTermProjection` for every mined key that is already consolidated, so visibility and routing refresh in the same pass. New test: `a term that gains a local-only occurrence is re-routed in the same pass`. The embedded text is the definition, written at consolidation through the chokepoint, so a later occurrence cannot leak text that was not routed. |
| 3 | Both item types share one id | **Confirmed** (`index/item-key.ts:7`; the `ON CONFLICT(id)` upsert rewrites `type`). A routing flip now deletes the row, then upserts, in one transaction, so the old vectors drop with the row. New test: `a routing flip drops the old vectors`. `unprojectTerm` is unchanged. |
| 4 | Making `loadGlossaryCandidates` require `mapping` breaks `agents/glossary.ts` in Task 2 | **Fixed.** Task 2 passes `BUILTIN_SOURCE_MAPPING` there, and Task 4 switches it to `ctx.mapping`. |
| 5 | `OFFSET` paging with no tiebreaker | **Fixed.** `term_key ASC` is added to both queries. New test: tied scores with paging. |
| 6 | FTS cost on the read path | **Partly adopted.** The near-miss pool skips the stats recompute. `countByStatus` keeps one `EXISTS … LIMIT 1` per consolidated mined term, on the slow path only, and gains a 500-term timing test. A single-query count would need FTS per term anyway. |
| 7 | Term mode shows stored stats | **Fixed.** `effectiveView` is used in term mode, and the test now covers both modes. |
| 8 | Sweep transaction | **Fixed.** The sweep runs in one transaction. |
| 9 | Catch-up counts dropped from the pass state | **Fixed.** Catch-up counts are added into the summary and `writePassState`, the way the decisions pass does it. |
| 10 | `:555` is an `unprojectTerm` call | **Fixed.** The wording is corrected; that line stays as it is. |
| 11–13 | Test callers missed | **Fixed.** The parameters stay required (2a's ruling: a default hides a forgotten production caller), and the known test files are listed. |
| 14 | Contradictory sweep bullets | **Fixed.** The sweep is rewritten as one ordered block. |
