# Review: Role Packs P2 PR 2a (Source Mappings — Decisions Side) Implementation Plan

**Plan under review:** [`2026-10-25-role-packs-p2-pr2a-mappings-decisions.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-25-role-packs-p2-pr2a-mappings-decisions.md)  
**Date:** 2026-10-25  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Approved with actionable refinements and implementation caveats noted below.

---

## 1. Executive Summary & Architectural Assessment

The implementation plan for **P2 PR 2a** (`feat(decisions): role packs and your config choose which sources decisions are mined from`) is well-structured, disciplined, and thoroughly aligned with the Project 2 design specification.

Splitting Project 2 into PR 2a (config layers, pack validation/conflict checking, resolver, schema V74, catch-up mechanism, and the decisions pipeline) and PR 2b (glossary reconciliation, term search projection, and remote embedding routing) is a wise strategic choice that keeps the changeset manageable, reviewable, and low-risk.

Particularly strong aspects of the plan:
1. **Liveness & Non-Destructive Hiding:** Reads reflect configuration changes immediately, unmapped or excluded rows are hidden without data deletion, and orphan decisions as well as owner-accepted agent decisions (`nimbus:capture`) remain visible.
2. **Deterministic Precedence Hierarchy:** The resolution order (`pack < base < profile`, with `exclude` beating `map` within a layer) and the fail-closed rejection of `nimbus:*` types across all layers preserve repository security invariants (specifically I28).
3. **Resilient Catch-Up Tracking:** Reconciling cursors at run start using composite keys (`watermark_ms`, `watermark_id`) in `source_catchup_state` avoids re-mining historical data upon pack re-installation while ensuring no items modified during unmapped intervals are missed.

Below are critical implementation traps, omitted files, and ergonomic recommendations to address before or during execution.

---

## 2. Critical Implementation Pitfalls & Bugs to Prevent

### 2.1 Decouple Candidate Mining from Watermark Updates in `commitBatch`
In Task 4 (lines 142 and 159), the plan specifies:
> *"Catch-up runs BEFORE the delta scan, per type... it mines exactly like commitBatch but advances the catch-up row; an empty batch sets done = 1... keep commitBatch's mining loop shared, not copied."*

**Codebase Reality & Trap:**  
In [`packages/gateway/src/decisions/decision-extract.ts:180-211`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-extract.ts#L180-L211), `commitBatch` does two things inside one transaction:
1. Loops through `rows` and calls `mineCues` + `upsertCandidate`.
2. Calls `writePassState(db, ...)` which updates `decision_pass_state` (the main delta watermark).

If catch-up calls `commitBatch` directly, it will overwrite the main delta watermark with an older catch-up timestamp (e.g. from months or days ago). This would regress the main pass cursor and trigger a massive, redundant re-scan across the entire database!

**Recommendation:**  
Refactor `commitBatch` to separate candidate mining from watermark committing:
```ts
function mineCandidateRows(
  db: Database,
  rows: readonly ScanRow[],
  opts: DecisionPassOptions,
): number {
  let batchDiscovered = 0;
  for (const r of rows) {
    const serviceType = `${r.service}:${r.type}`;
    for (const hit of mineCues(scanText(r))) {
      upsertCandidate(db, {
        id: decisionRowId(r.id, hit.normalized),
        sourceItemId: r.id,
        cueTier: hit.tier,
        cueText: hit.cueText,
        priority: computePriority({ tier: hit.tier, serviceType, mapping: opts.mapping }),
        decidedAt: r.modified_at,
        nowMs: opts.nowMs,
      });
      batchDiscovered++;
    }
  }
  return batchDiscovered;
}
```
- In the main delta scan: call `mineCandidateRows` and then `writePassState`.
- In the catch-up scan: call `mineCandidateRows` and then update `source_catchup_state`.

---

### 2.2 `clearDecisions` (`--rebuild`) Must Reset `source_catchup_state`
In [`packages/gateway/src/decisions/decision-store.ts:351-362`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-store.ts#L351-L362):
```ts
export function clearDecisions(db: Database): void {
  db.transaction(() => {
    dbRun(db, "DELETE FROM decision_evidence WHERE ...", []);
    dbRun(db, "DELETE FROM decision_record WHERE extraction_source IS NOT 'agent'", []);
    dbRun(db, "DELETE FROM decision_pass_state", []);
  })();
}
```
**Trap:**  
If `clearDecisions` does not clear `source_catchup_state`, running `nimbus decisions --rebuild` will reset the main watermark to 0, but custom/pack-mapped rows in `source_catchup_state` will retain their existing watermark and `done = 1`. Consequently, a rebuild will re-scan built-in sources from scratch, but will completely skip historical items for pack-mapped or owner-mapped sources!

**Recommendation:**  
Add `dbRun(db, "DELETE FROM source_catchup_state WHERE pass = 'decisions'", []);` inside `clearDecisions`.

---

### 2.3 `selectSnippetUpgrades` Must Also Filter by Effective Source Types
In Task 4 (line 144):
> *"selectPendingByPriority gains the effective set: LEFT JOIN item i … WHERE (i.id IS NULL OR <filter>), so excluded types' pending rows are not sent to the model (they stay pending)."*

**Trap:**  
In `decision-extract.ts`, Phase B does not only call `selectPendingByPriority`; it also reserves slots for snippet upgrades via [`selectSnippetUpgrades`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-store.ts#L177-L187):
```ts
export function selectSnippetUpgrades(db: Database, limit: number): DecisionRecord[]
```
If `selectSnippetUpgrades` does not also apply the effective source filter, any snippet decision previously extracted from an excluded type (e.g. `slack:message`) will still be selected and sent to the LLM for upgrade. This directly contradicts the requirement that excluded sources consume zero LLM model calls.

**Recommendation:**  
Update `selectSnippetUpgrades` to accept the effective mapping / filter and join `item i` using the identical visibility predicate.

---

### 2.4 Index Utilization: Use `WHERE i.service = ? AND i.type = ?` Instead of `service || ':' || type = ?`
In Task 4 (line 142):
> *"scanning `service || ':' || type = ?` with its own composite cursor up to (and including) the main cursor captured at run start"*

**Database Performance Trap:**  
In SQLite ([`unified-item-v3-sql.ts:33-35`](file:///C:/gitrep/Nimbus/packages/gateway/src/index/unified-item-v3-sql.ts#L33-L35)), `item` has separate indexes on `service` (`idx_item_service`) and `type` (`idx_item_type`).
Evaluating an expression like `WHERE (i.service || ':' || i.type) = ?` cannot use those indexes without an expression index, forcing SQLite to perform a full table scan and string concatenation on every single item in the database for each catch-up batch.

**Recommendation:**  
Since each catch-up batch operates on a single known `serviceType` (e.g. `readwise:highlight`), split it into `service` and `type` components:
```sql
WHERE i.service = ? AND i.type = ?
  AND (i.modified_at > ? OR (i.modified_at = ? AND i.id > ?))
  AND (i.modified_at < ? OR (i.modified_at = ? AND i.id <= ?))
ORDER BY i.modified_at ASC, i.id ASC
LIMIT ?
```
This enables SQLite to use `idx_item_service` and `idx_item_modified_at`, making catch-up execution instantaneous even on large local indexes (50,000+ items).

---

### 2.5 Advance Catch-Up Cursor to `mainCursor` When Reaching `done = 1`
When catch-up finishes for a source type (either because a batch returned fewer items than the batch limit or zero items), the row in `source_catchup_state` is updated with `done = 1`.

**Recommendation:**  
Ensure that whenever `done = 1` is recorded, `watermark_ms` and `watermark_id` are explicitly set to the `mainCursor` captured at run start (not left at the last item's timestamp). This guarantees that if the source type is later unmapped, its recorded watermark accurately reflects that it was caught up to that exact main cursor position.

---

## 3. Missing Files & Type-Check Call Sites

### 3.1 `packages/gateway/src/ipc/diagnostics-rpc.ts` (Task 2)
In Task 2, `config/config-explain.ts` is modified to output notes for `sources`.
However, `config-explain.ts` relies on injected hooks for domain-specific notes (see line 494: `opts.agentVisibilityNotes`).
In [`packages/gateway/src/ipc/diagnostics-rpc.ts:240-245`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/diagnostics-rpc.ts#L240-L245):
```ts
    value: explainConfig(reader, path, undefined, {
      ...(ctx.fleetJobCheck === undefined ? {} : { fleetJobCheck: ctx.fleetJobCheck }),
      agentVisibilityNotes: () =>
        describeAgentVisibility(resolveAgentVisibility(reader.snapshot(), CATALOG_AGENT_NAMES)),
    }),
```
If `sourceMappingNotes` are injected via `opts`, `diagnostics-rpc.ts` must be updated to pass `sourceMappingNotes: () => describeSourceMapping(resolveSourceMapping(reader.snapshot()))`. Otherwise, CLI calls over IPC (`nimbus config explain sources`) will not receive source mapping notes.  
*Action:* Add `packages/gateway/src/ipc/diagnostics-rpc.ts` to Task 2 Files.

---

### 3.2 `packages/gateway/src/agents/_lib/tour-selectors.ts` (Task 5)
In [`packages/gateway/src/agents/_lib/tour-selectors.ts:151`](file:///C:/gitrep/Nimbus/packages/gateway/src/agents/_lib/tour-selectors.ts#L151):
```ts
const rows = listDecisions(ctx.db, {
  sinceMs: ctx.nowMs - DEFAULT_WINDOW_MS,
  minConfidence: ctx.decisionsMinConfidence,
  limit: 20,
});
```
`tour-selectors.ts` calls `listDecisions`. If `listDecisions` requires `{ mapping: SourceMapping }`, `tour-selectors.ts` will fail typechecking unless updated to pass `ctx.mapping`.  
*Action:* Add `packages/gateway/src/agents/_lib/tour-selectors.ts` to Task 5 Files, and ensure `TourSelectorCtx` (built in `ipc/tour-rpc.ts:73`) includes `mapping`.

---

### 3.3 Existing `listDecisions` Call Sites in Tests
If `listDecisions(db, opts & { mapping: SourceMapping })` makes `mapping` mandatory, existing tests that call `listDecisions` without `mapping` will fail typechecking:
- [`packages/gateway/src/mcp-sink/capture-native.test.ts:130,138`](file:///C:/gitrep/Nimbus/packages/gateway/src/mcp-sink/capture-native.test.ts#L130)
- [`packages/gateway/src/decisions/decision-truncation-report.test.ts:160`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-truncation-report.test.ts#L160)

*Action:* Either update these call sites to pass `mapping: BUILTIN_SOURCE_MAPPING`, or (recommended below) default `mapping = BUILTIN_SOURCE_MAPPING` on low-level store functions.

---

## 4. Interface & Ergonomics Suggestions

### 4.1 Provide `sourceMapFromList` Helper for `pack-layer-store.ts`
In Task 2, `CleanPack` gains `sourceMap: ReadonlyMap<string, SourceKind>`, and `checkPackFragment` parses `lists.get("sources.map")` as `readonly string[] | undefined`.  
Both `readPack` (line 294) and `check` (line 356) will need to convert that list of strings into a `Map<string, SourceKind>`.
Exporting a helper from `sources/source-mapping.ts`:
```ts
export function sourceMapFromList(entries: readonly string[] | undefined): ReadonlyMap<string, SourceKind>
```
avoids duplicate parsing logic and ensures that conflict detection in `pack-layer-store.ts:conflicts` remains simple and uniform.

---

### 4.2 Support `scoredKind` in `ConfidenceInput` to Avoid Per-Row Item Queries
In Task 5 and Spec § 7:
> *"The check also stops issuing a per-row SELECT service, type (`agents/decisions.ts:32`) for rows that carry a kind."*

If `ConfidenceInput` in `decision-confidence.ts` is widened to:
```ts
export interface PriorityInput {
  readonly tier: CueTier;
  readonly serviceType?: string;
  readonly scoredKind?: SourceKind | null;
  readonly mapping?: SourceMapping;
}
```
Then `computeConfidence` can evaluate:
```ts
const authority = input.scoredKind != null 
  ? authorityOfKind(input.scoredKind) 
  : sourceAuthority(input.serviceType ?? "", input.mapping);
```
This allows `agents/decisions.ts` in the `staleScoreCount` loop and `toEntry` explain path to pass `scoredKind: r.scoredKind` directly, avoiding the per-row `SELECT service, type FROM item WHERE id = ?` entirely.

---

### 4.3 Default `mapping = BUILTIN_SOURCE_MAPPING` on Low-Level Store Queries
In Task 5 Interfaces:
`listDecisions(db, opts: { sinceMs: number; minConfidence: number; limit: number; mapping?: SourceMapping })`  
`countByStatus(db, mapping: SourceMapping = BUILTIN_SOURCE_MAPPING)`  
`loadDecisionCandidates(db, opts: { sinceMs: number; mapping?: SourceMapping })`

Making `mapping` optional with a fallback to `BUILTIN_SOURCE_MAPPING` on the pure SQL store functions eliminates ripple test breakage across non-pack tests while keeping strict requirements on the higher-level context objects (`DecisionPassOptions.mapping`, `DecisionsContext.mapping`, `NegotiateContext.mapping`).

---

## 5. Open Questions for Plan Author

1. **Re-kinding Representation in `diffPacks` / `pack-prompt.ts`:**  
   When updating an installed pack where a source mapping changed its kind (e.g. `readwise:highlight=note` changed to `readwise:highlight=doc`), how should `diffPacks` report it?  
   Does it emit `added` + `removed`, or a distinct `changed` category (e.g., `changed: readwise:highlight from note to doc`)?  
   *(Recommendation: `diffPacks` can treat a kind change as `changed`, rendering `changed: readwise:highlight as doc (was note)`, or treat it as removed + added).*

2. **Transaction Boundary for `reconcileCatchupRows`:**  
   Does `reconcileCatchupRows` run inside the caller's transaction or maintain its own transaction?  
   *(Recommendation: Wrap `reconcileCatchupRows` in its own `db.transaction` at the very start of `runDecisionPass`, before catch-up and delta scanning begin).*

3. **User Feedback for `--service` on an Excluded Source:**  
   If a user executes `nimbus decisions --service slack` while `slack:message` is excluded via `nimbus.toml`, `listDecisions` filters out all Slack decisions.  
   Will the brief output report a `GapNote` indicating that the service was excluded by config, or will it simply state 0 decisions found?

---

## 6. Conclusion & Readiness

The plan is well-conceived, comprehensive, and ready for execution once the points above (especially decoupling candidate mining in `commitBatch`, resetting catch-up state in `clearDecisions`, and adding `diagnostics-rpc.ts` and `tour-selectors.ts` to the touched file list) are incorporated.

Path forward: Proceed to execution with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

---

## Disposition (plan author, 2026-10-25)

Every claim was checked against `origin/main` at `ebd2a18f`.

| # | Finding | Disposition | Where |
|---|---|---|---|
| 2.1 | `commitBatch` writes the main watermark; catch-up through it rewinds the cursor | **Fixed.** Confirmed (`decision-extract.ts:180-211`). The plan now splits `mineRows` from the watermark writes, and catch-up never calls `writePassState`. New test `catch-up never moves the main watermark`, red-proved through the old path. | Task 4 rules + tests |
| 2.2 | `clearDecisions` keeps `source_catchup_state` | **Fixed, reasoning corrected.** A rebuild does not skip history: the main cursor resets to 0, so the delta scan covers every effective type. The real cost is a stale `done = 0` cursor re-mining items the delta already handled on the next run. The plan adds a `DELETE … WHERE pass = 'decisions'` and the test `rebuild clears catch-up cursors`. | Task 4 |
| 2.3 | `selectSnippetUpgrades` ignores the mapping | **Fixed.** Confirmed: it is Phase B's second model queue (`:462`). It shares one `pendingWorkFilter` with `selectPendingByPriority`. New test `exclude stops snippet upgrades`. | Task 4 |
| 2.4 | Single-type catch-up should not use the concatenation | **Fixed** for catch-up (`i.service = ? AND i.type = ?`). The delta scan keeps today's `IN` over the concatenation, because that is unchanged behaviour and its range scan already uses the `modified_at` index. | Task 4 |
| 2.5 | Set the cursor to the main cursor on `done = 1` | **No change.** A `done = 1` row's cursor is never read. When the type is unmapped, reconcile overwrites it with the main cursor at that moment, which is already in the plan. | — |
| 3.1 | `diagnostics-rpc.ts` must pass the notes hook | **Fixed.** Confirmed (`:240-245`). The file is added to Task 2, and an IPC-level test checks the notes. | Task 2 |
| 3.2 | `tour-selectors.ts` calls `listDecisions` | **Fixed.** Confirmed (`:151`). It is added to Task 5, and `TourSelectorCtx` gains `mapping`. | Task 5 |
| 3.3 / 4.3 | Test call sites break; make `mapping` optional on store reads | **Call sites listed. A default is declined (Ruling).** A default would let a production read forget the mapping and show excluded rows, the Review Focus 2 failure, and only a required parameter lets typecheck find every read. The test edits are mechanical. | Task 5 |
| 4.1 | `sourceMapFromList` helper | **Adopted.** | Task 1 Produces, Task 2 Consumes |
| 4.2 | `scoredKind` on the confidence input | **Adopted.** With a kind, `serviceType` is not consulted, so the stale check and the explain path skip the per-row item SELECT, as spec § 7 asks. | Task 4 Produces, Task 5 Step 3 |
| Q1 | How a re-kind shows in the update prompt | **Ruled:** removed plus added, the same as the other list diffs. Test added. | Task 2 |
| Q2 | `reconcileCatchupRows` transaction | **Ruled:** it gets its own transaction at run start, before catch-up and the delta scan. | Task 4 |
| Q3 | `--service` on an excluded source | **Deferred (Ruling).** There is no new gap line in 2a. Only the owner can exclude, and `config explain sources` lists each exclusion. Cost if wrong: an owner who forgot an exclude sees no hint. | Task 5 Step 3 |
