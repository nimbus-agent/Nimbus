# Review: Role Packs Project 2 (Source Mapping & Unification) Design Spec

**Spec under review:** [`2026-10-25-role-packs-p2-source-mapping-design.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-25-role-packs-p2-source-mapping-design.md)  
**Date:** 2026-10-25  
**Reviewer:** AI Assistant (Antigravity)  
**Status:** Ready with actionable fixes, implementation caveats, and open questions.

---

## Executive Summary

The Project 2 design specification provides a clean, well-reasoned architecture for lifting hardcoded decision and glossary extraction inputs into unified semantic kinds (`doc`, `note`, `ticket`, `commit`, `pull_request`, `review`, `chat`, `whiteboard`, `spec`, `rfc`, `adr`, `incident`) backed by user overrides and pack defaults.

The design makes several particularly strong architectural decisions:
- **Zero-downtime, non-blocking catch-up:** Reconciling newly mapped sources in the background without truncating extraction watermarks or re-scanning the entire corpus.
- **Local-only semantic integrity:** Splitting glossary term projection into `nimbus:glossary_term` (cloud-searchable) and `nimbus:glossary_term_local` (local-only) preserves strict zero-cloud data leak guarantees while keeping set disjointness intact.
- **Fail-open extraction with fail-closed prompt resolution:** Prevents pack churn from causing destructive state loss in the underlying database.

Below are codebase mismatches, edge cases, implementation traps, and open questions identified against the actual `packages/gateway` codebase.

---

## 1. Codebase Mismatches & Missing Schema Details

### 1.1 `matchesTicketKey` SQL Projection Missing `type` Column
In Section 3 (Decision Scope), the spec states:
> `matchesTicketKey(db, decision, text)` checks whether any known ticket key appears in `text`. It currently queries:
> ```ts
> const row = db.query(`SELECT service FROM item WHERE id = ?`).get(decision.sourceItemId);
> ```
> Update to consult `effectiveKind(row.service, row.type) === 'ticket'`.

**Codebase Reality:**
In [`packages/gateway/src/decisions/decision-service-scope.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-service-scope.ts#L106-L108):
```ts
const row = db
  .query("SELECT service, metadata FROM item WHERE id = ?")
  .get(decision.sourceItemId) as { service?: string; metadata?: string } | null;
```
The query selects `service, metadata` but does **not** select `type`. To pass `(row.service, row.type)` to `effectiveKind()`, the query in `matchesTicketKey` MUST be updated to:
```sql
SELECT service, type, metadata FROM item WHERE id = ?
```
Otherwise, `row.type` will evaluate to `undefined` at runtime and fail the ticket check.

---

### 1.2 `PackLayerStore.CleanPack` Missing List Conflict Tracking
In Section 4, the spec requires that two packs declaring different kinds for the same source type (e.g. `jira:issue=ticket` vs `jira:issue=doc`) conflict deterministically, and:
> `PackLayerStore.conflicts(packs)`: adds check for duplicate keys in `pack.sources.map` across enabled packs. If pack A maps `x` to `ticket` and pack B maps `x` to `doc`, reject before prompt.

**Codebase Reality:**
In [`packages/gateway/src/packs/pack-layer-store.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-layer-store.ts#L132-L137):
```ts
export interface CleanPack {
  readonly id: string;
  readonly name: string;
  readonly scalars: ReadonlyMap<string, boolean | number | string>;
  readonly jobNames: ReadonlySet<string>;
}
```
Currently, `CleanPack` only records `scalars` and `jobNames`. `conflicts()` only checks scalar collisions:
```ts
// pack-layer-store.ts:167
for (const [key, value] of pack.scalars) { ... }
```
`CleanPack` must be extended with:
```ts
readonly sourceMappings: ReadonlyMap<string, UnifiedKind>;
```
and `pack-layer-store.ts:conflicts` must iterate over `pack.sourceMappings` to ensure no two active packs map the same source key to differing unified kinds.

---

### 1.3 Ambiguous Column Collisions in Decision SQL Queries (`listDecisions` / `countByStatus`)
In Section 7, the spec specifies:
> Update `listDecisions` and `countByStatus` to join `item` and filter by effective set.

**Implementation Trap:**
In [`packages/gateway/src/decisions/decision-store.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-store.ts#L182-L210), `listDecisions` constructs queries like:
```sql
SELECT d.* FROM decision_record d ...
```
If this is changed to:
```sql
SELECT * FROM decision_record d LEFT JOIN item i ON i.id = d.source_item_id
```
SQLite will return ambiguous columns where `item.id`, `item.created_at`, `item.updated_at`, and `item.title` shadow the corresponding fields in `decision_record`.
- The query MUST explicitly project `SELECT d.* FROM decision_record d LEFT JOIN item i ON i.id = d.source_item_id`.
- Furthermore, because `decision_record.source_item_id` can reference an item that was deleted or archived, an `INNER JOIN` would drop decisions whose underlying item was expunged. Ensure the query uses:
  ```sql
  LEFT JOIN item i ON i.id = d.source_item_id
  WHERE (i.service IS NULL OR i.service || ':' || i.type IN (...))
  ```
  or preserves orphan decisions as specified in § 7 ("Decision referencing a deleted item").

---

### 1.4 `computeTermStats` Signature Must Accept Source Filter Set
In Section 7, the spec notes:
> `computeTermStats`: change the items query to filter by effective glossary set.  
> `reconcileGlossary`: runs term-frequency and candidate promotion over the **known** set (not effective), so disabled packs don't demote terms that exist in indexed data.

**Codebase Reality:**
In [`packages/gateway/src/glossary/glossary-store.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/glossary/glossary-store.ts#L105-L121):
`computeTermStats(db)` hardcodes `glossarySourceFilter()`.
If `reconcileGlossary` must run over the **known** set while read-side statistics or listings run over the **effective** set, `computeTermStats` cannot hardcode the filter. Its signature must accept an explicit source list or filter expression:
```ts
export function computeTermStats(
  db: Database,
  options?: { sourceFilterSql?: string }
): TermStats { ... }
```

---

## 2. Security Bounds & Implementation Traps

### 2.1 Pack Injection / Invariant 5: Forbidding `nimbus:*` Type Mappings
In [`packages/gateway/src/security-invariants.test.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/security-invariants.test.ts#L2910-L2935), Nimbus enforces Invariant 5:
> **Capture items are never extraction input:**
> No extractor may ever select `service = 'nimbus' AND type = 'capture'`. Doing so creates recursive feedback loops and ingestion poisoning.

The proposed grammar in Section 4:
```
sources.map:
  - "jira:issue=ticket"
```
validates tokens against `[a-z0-9_]+:[a-z0-9_]+=[a-z0-9_]+`.
This syntax would permit a malicious or poorly designed pack to declare:
```yaml
sources.map:
  - "nimbus:capture=note"
  - "nimbus:glossary_term=doc"
```
**Required Guard:**
The source map parser in `packages/gateway/src/sources/source-map.ts` MUST explicitly reject any mapping whose source `service` is `'nimbus'`, or whose type belongs to internal gateway storage. It should strictly enforce:
```ts
if (service === 'nimbus') {
  throw new Error(`Security invariant violation: internal 'nimbus:*' types cannot be remapped in sources.map`);
}
```

---

### 2.2 `source_catchup_state` Schema Details & Race Free Catch-up
Section 6 outlines the table:
```sql
CREATE TABLE IF NOT EXISTS source_catchup_state (
  pass TEXT NOT NULL,
  service_type TEXT NOT NULL,
  watermark_ms INTEGER NOT NULL,
  watermark_id TEXT NOT NULL,
  PRIMARY KEY (pass, service_type)
);
```
**Edge cases to handle:**
1. **Cursor Progression:**
   In SQLite, paging with `(updated_at, id) > (watermark_ms, watermark_id)` requires standard composite keyset pagination:
   ```sql
   WHERE (updated_at > ?) OR (updated_at = ? AND id > ?)
   ```
2. **Main Pass Convergence:**
   The background catch-up task advances `(watermark_ms, watermark_id)` up to `target_watermark_ms` (the main pass watermark at start of catch-up).
   If the main pass updates in the meantime, once catch-up reaches `target_watermark_ms`, it can delete the row from `source_catchup_state`. The main pass will naturally pick up newer items.
3. **Cancellation / Pack Disabling mid-catchup:**
   If a pack is disabled while catch-up is running, catch-up should check `isTypeActive(serviceType)` between batches (every 100 items) and exit early if the mapping is no longer active.

---

### 2.3 Storing `scored_kind` on `decision_record` (V74 Migration)
In Section 7:
> When the active kind of an item changes, existing scores may be invalid. Check at score-read time:
> `if (decision.scored_kind !== effectiveKind(item.service, item.type)) { reScore(); }`

**Analysis:**
This is an excellent optimization. Adding `scored_kind TEXT` to `decision_record` in a schema migration (e.g. V74):
1. Avoids repeated `SELECT service, type FROM item WHERE id = ?` queries in loops inside `packages/gateway/src/agents/decisions.ts:260-275`.
2. Cleanly detects kind shifts (e.g. if an item changed from `ticket` to `doc` because the user changed their pack config).
3. Backfills existing rows with:
   ```sql
   ALTER TABLE decision_record ADD COLUMN scored_kind TEXT;
   UPDATE decision_record SET scored_kind = (
     SELECT CASE 
       WHEN i.service = 'jira' THEN 'ticket'
       WHEN i.service = 'github' AND i.type = 'issue' THEN 'ticket'
       WHEN i.service = 'slack' THEN 'chat'
       ELSE 'doc'
     END
     FROM item i WHERE i.id = decision_record.source_item_id
   );
   ```

---

### 2.4 Google Docs Rewrite Migration Atomicity
Section 8 specifies rewriting `service='google_drive' AND type='file'` with `mimeType = 'application/vnd.google-apps.document'` to `type='doc'`.

**Considerations:**
- **Connector Sync Compatibility:** When `connector:google_drive` syncs again, will it emit `type: 'doc'` or will it revert them back to `type: 'file'`?
  The Google Drive connector sync logic must be updated **simultaneously** with the V74 data migration so that incoming syncs produce `type: 'doc'`.
- **FTS and Embeddings:**
  In Nimbus, `item` rows are indexed into `item_fts` and have corresponding entries in `vector_metadata`. Changing `item.type` in-place does not change `id`, but if embedding routing rules partition by `type`, check if vector routing caches need invalidation. Fortunately, `google_drive:file` and `google_drive:doc` are both prose types, so embedding vectors remain valid.

---

## 3. Open Questions for Spec Author / Owner

1. **Catch-up State on Pack Toggle:**
   If a user enables a pack (initiating a catch-up scan), disables it 5 minutes later, and then re-enables it tomorrow:
   - Should `source_catchup_state` be preserved (resuming where it left off), or truncated upon removal of the mapping?
   - *Recommendation:* Keep the cursor row. When re-enabled, it resumes from `(watermark_ms, watermark_id)`, catching up on any items it missed while disabled.

2. **Decision Candidate Scan Delta vs Catch-up Query:**
   In [`packages/gateway/src/decisions/decision-extract.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-extract.ts#L45-L78), `scanDelta` scans `item` where `updated_at > watermark`.
   If a catch-up batch runs concurrently with `scanDelta`, both may attempt extraction on the same item if `updated_at` happens to match the border.
   Does `extractDecisions` handle idempotent upserts on `decision_record`?
   *(Answer from code: Yes, decisions have content-hash/dedup keys, but adding an explicit `WHERE NOT EXISTS` or standard `INSERT OR REPLACE` avoids race warnings).*

3. **User Override vs Enterprise Policy Precedence:**
   Section 4 defines the precedence chain:
   ```
   config.sources.map (user) > pack.sources.map (packs, alphabetical by pack ID) > BUILTIN_SOURCE_MAP (gateway defaults)
   ```
   Will Project 4 (Enterprise/Admin lock-down) need a higher-priority layer above user config?
   If so, consider leaving room in the precedence resolution for `admin.sources.map > user.sources.map > pack.sources.map`.

---

## 4. Summary of Recommended Edits to Spec

| Section | Recommended Fix |
|---|---|
| **§ 3 Decision Scope** | Note that `matchesTicketKey` must query `SELECT service, type, metadata` from `item`, not just `service, metadata`. |
| **§ 4 Pack Map Declarations** | Explicitly add security restriction: `service` in `sources.map` cannot be `'nimbus'`. |
| **§ 4 Pack Layer Store** | Note extension of `CleanPack` interface to include `sourceMappings` and updating `conflicts()` to assert uniqueness across enabled packs. |
| **§ 7 Glossary Extraction** | Note update to `computeTermStats` signature to accept a dynamic filter/source list for known vs effective sets. |
| **§ 7 Decision Storage** | Explicitly specify `SELECT d.*` (avoiding `SELECT *`) on `LEFT JOIN item i` to prevent column shadowing. |
| **§ 8 Google Drive Migration** | Note that `connector:google_drive` sync emitter must be updated in lockstep with the SQL migration to avoid reverting `doc` back to `file`. |

---

## Disposition (spec author, 2026-10-25)

Every item was checked against `origin/main` (7a14406a) before acting. The review describes some
things the spec does not say: a 12-kind list (the spec has five), YAML syntax (the spec uses TOML
lists), a "Project 4 enterprise lock-down" (Project 4 is the desktop), a re-score-at-read-time rule,
and a SQL data migration for Drive. Those premises are not adopted; the findings underneath them
were judged on the code.

| Item | Verdict | Action |
| --- | --- | --- |
| 1.1 `matchesTicketKey` selects no `type` | Valid (`decision-service-scope.ts:106` selects `service, metadata`) | Fixed: § 3 requires `service, type, metadata`. |
| 1.2 `CleanPack` has no list field | Valid (`pack-layer-store.ts:134`) | Fixed: § 4 names the new field and the `conflicts()` comparison. |
| 1.3 `SELECT *` shadowing on the join; orphans | Valid (`decision-store.ts:276` is `SELECT *`); orphan passthrough was already in § 7 | Fixed: § 7 requires `d.*` and gives the `i.id IS NULL OR …` shape. |
| 1.4 `computeTermStats` hardcodes the filter | Valid (`glossary-store.ts:106,137`) | Fixed: § 7 makes the source set a parameter (known for reconcile, effective for reads). |
| 2.1 `nimbus:*` mappings bypass I28 | **Valid and the most important.** The I28 test (`security-invariants.test.ts:2926`) checks only the two literal sets, so a mapping could feed `nimbus:capture` to extraction | Fixed: § 4 refuses `nimbus:*` for every layer, owner included, at the parser and again in the resolver; the I28 test and docs are rewritten in the same commit. |
| 2.2 catch-up cursor / delete row / cancel mid-catch-up | Cursor shape already in § 6; deleting the row is rejected (the `done` row is what prevents re-mining); cancel between batches adopted | Fixed: § 6 re-checks the effective set between batches. |
| 2.3 `scored_kind` backfill SQL | The proposed SQL invents kinds (`chat`) and defaults everything else to `doc`, which would make every stale-score check wrong | Fixed differently: § 7 backfills from the built-in table only, NULL otherwise, NULL falls back to the current kind. |
| 2.4 Drive sync reverting `doc` to `file`; embeddings | Premise wrong (no SQL migration in the spec), and "both are prose types" is false (`google_drive:file` is in neither routing set) | Fixed: § 8 states the connector writes `doc` itself, and a rewritten row is re-embedded. |
| Q1 catch-up row on pack toggle | Valid, and it exposed a real gap: items of a type modified while it was unmapped would be skipped forever | Fixed: § 6 resets the row to the main cursor when the type leaves the set, so re-adding catches up only the unmapped window. |
| Q2 concurrent catch-up and delta scan | Not concurrent: both run in the same pass run | Fixed: § 6 says so; idempotency was already required. |
| Q3 admin/policy layer above the owner | Out of scope: no team-baseline layer exists and org policy (I22) has no `[sources]` lock-off | Deferred: recorded in § 10. |
