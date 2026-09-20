# Implementation Plan Review: Index Lane Coverage Gate

**Review of:** [`2026-09-20-index-lane-coverage.md`](file:///C:/gitrep/Nimbus/.claude/worktrees/lane-coverage/docs/superpowers/plans/2026-09-20-index-lane-coverage.md)  
**Initiative:** B4 (bug-hunt audit) · `docs/roadmap.md` § Maintenance-initiative follow-ups  
**Date:** 2026-09-20  
**Status:** Approved with critical regex/extraction fixes & architectural enhancements

---

## 1. Executive Summary & Assessment

The implementation plan is exceptionally well-structured:
- Follows strict **TDD** (write failing test $\rightarrow$ observe failure $\rightarrow$ implement $\rightarrow$ pass $\rightarrow$ commit).
- Has clear modular task boundaries (`sql-literals.ts`, `alias-binding.ts`, `read-sites.ts`, `writer-emissions.ts`, `check-index-lane-coverage.ts`).
- Correctly divides the rollout into **PR 1 (Census report-only)** and **PR 2 (Typed map + blocking gate)** with **Phase 3 (Per-bug remediation PRs)**.
- Adheres to Nimbus engineering invariants: pure functions for audit rules, no `any`, anti-vacuity suites, descending ratchets on escape hatches (`known-dead`).

However, testing the proposed regexes and extraction logic against the real Nimbus codebase revealed several **critical edge cases** where queries and metadata writes would be missed or falsely classified. These must be addressed during implementation.

---

## 2. Critical Edge Cases & Implementation Fixes

### Fix 1: Task 1.4 Regex Misses Optional Chaining (`meta?.["key"]`) and Single Quotes
**Problem:**  
In [`metrics/dora.ts:110`](file:///C:/gitrep/Nimbus/packages/gateway/src/metrics/dora.ts#L110), the code reads:
```ts
const meta = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : null;
if (meta?.["conclusion"] !== "success") continue;
```
The plan's proposed regex:
```ts
/\bmeta(?:data)?\[\s*"([A-Za-z0-9_]+)"\s*\]/g
```
**fails to match `meta?.["conclusion"]`** because of the optional chaining `?.` operator! It also misses single quotes (e.g. `meta['conclusion']`).

**Required Fix for Task 1.4:**  
Update the regex to:
```ts
const JS_META_READ = /\bmeta(?:data)?(?:\?\.)?\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g;
```
Add explicit unit test cases for `meta?.["key"]`, `metadata?.['key']`, and `meta['key']`.

---

### Fix 2: Task 1.1 Misses Queries in Double & Single Quotes
**Problem:**  
In Task 1.1, `extractSqlLiterals` scans only backtick template strings:
```ts
for (let i = 0; i < contents.length; i++) {
  if (contents[i] !== "`") continue;
  // ...
```
Across `packages/gateway/src/`, multiple queries are written with double or single quotes rather than backticks:
- `ownership-store.ts:28`: `db.query("SELECT id, label, metadata FROM graph_entity WHERE type = ? ...")`
- `platform/assemble.ts`: `db.query("SELECT metadata, url FROM item WHERE id = ?")`
- `perf/perf-fixture.test.ts`: `db.query("SELECT COUNT(*) AS n FROM item")`

**Required Fix for Task 1.1:**  
Support template literals, double-quoted strings, and single-quoted strings matching `SQL_SHAPE`:
```ts
export function extractSqlLiterals(contents: string): readonly SqlLiteral[] {
  // Extract backtick template literals (with ${...} replaced by __INTERP__)
  // PLUS single/double quoted string literals that match SQL_SHAPE
}
```

---

### Fix 3: Task 1.3 Regex Misses `type IN ('...', '...')` Predicates
**Problem:**  
Task 1.3 defines:
```ts
const TYPE_CMP = /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s*=\s*'([a-z0-9_]+)'/gi;
```
This misses SQL queries using `IN` lists:
- `engine/run-ask.ts`: `AND type IN ('issue', 'pr')`
- `decisions/decision-corroborate.ts`: `WHERE t.type IN ('pr', 'commit')`
- `multimodal/orphan-prune.ts`: `WHERE type IN ('image_understanding', 'video_understanding')`

**Required Fix for Task 1.3:**  
Add an `IN` list extractor alongside `TYPE_CMP`:
```ts
const TYPE_IN_CMP = /(?:\b([a-z_][a-z0-9_]*)\.)?\btype\s+IN\s*\(\s*([^)]+)\s*\)/gi;
```
When `TYPE_IN_CMP` matches, extract each quoted literal inside the parenthesis list (e.g. `'issue', 'pr'` $\rightarrow$ emits triples for both `issue` and `pr`).

---

### Fix 4: Task 1.6 Scoping of Metadata-Key Unmatched Triples
**Problem:**  
In Task 1.6:
> `unmatchedItemReads` is the payload: a `type` triple with no writer emitting that type, or a `metadata-key` triple no writer emits for any type read alongside it.

If metadata key matching is evaluated globally against **all** writer emissions regardless of `itemType`, cross-type pollution can occur:
- If `jira-sync.ts` emits `parent_key` on `type: "issue"`, but `github-sync.ts` does **not** emit `parent_key` on `type: "pr"`, a query reading `metadata.parent_key` on `item.type = 'pr'` would falsely appear matched if evaluated against the global pool of all emitted metadata keys.

**Required Fix for Task 1.6:**  
When a SQL literal filters on both `table: "item"` + `type = '<typeLiteral>'` AND `json_extract(metadata, '$.<key>')`, pair the required metadata key with that specific `<typeLiteral>`. The census should assert that a writer exists emitting `type: '<typeLiteral>'` whose metadata contains `<key>`.

---

### Fix 5: Task 1.5 Shorthand, Quoted, and Spread Metadata Object Keys
**Problem:**  
In `connectors/**`, metadata objects are constructed using varied JavaScript idioms:
1. Object property shorthand: `{ workflowName, conclusion, headSha }` in `github-actions-sync.ts`.
2. Explicit key-value: `{ workflowName: name, runId: id }`.
3. Quoted keys: `{ "sync_status": syncStatus }` in `argocd-application-mapping.ts`.
4. Merged helpers: `metadata: mergeForwardPrStats(ctx.itemMetadata, extractPrMetadataForIndex(...))` in `github-sync.ts`.

**Required Fix for Task 1.5:**  
Ensure the metadata key extractor in `writer-emissions.ts` handles:
- Identifiers in shorthand properties (`{ foo }` $\rightarrow$ key `"foo"`).
- Quoted string literal keys (`{ "foo-bar": 1 }` $\rightarrow$ key `"foo-bar"`).
- Following helper return objects when `metadata:` calls a helper defined in the same or imported mapping file (e.g. `mapArgocdApplicationToItem` or `extractPrMetadataForIndex`).

---

## 3. Open Questions & Architectural Clarifications

### Q1: Multi-Service Query Representation in `INDEX_LANE_COVERAGE`
**Scenario:**  
[`metrics/dora.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/metrics/dora.ts#L93-L105) queries `WHERE service IN (${ciServices}) AND type = 'ci_run'`.
At runtime, `ciServices` can contain `github_actions`, `gitlab`, `jenkins`, `circleci`.

- **Design Question:** How does Task 2.1 represent this in `INDEX_LANE_COVERAGE`?
- **Recommendation:** Define one entry per concrete service in `INDEX_LANE_COVERAGE`:
  ```ts
  { service: "github_actions", itemType: "ci_run", requiredMetadataKeys: ["conclusion", "workflowName"], ... },
  { service: "gitlab", itemType: "ci_run", requiredMetadataKeys: ["status"], ... },
  { service: "jenkins", itemType: "ci_run", requiredMetadataKeys: ["result"], ... },
  { service: "circleci", itemType: "ci_run", requiredMetadataKeys: ["state"], ... }
  ```
  This cleanly exposes that DORA's check for `meta?.["conclusion"] !== "success"` is dead for GitLab, Jenkins, and CircleCI, rather than falsely treating `ci_run` as a monolithic covered type.

---

### Q2: Tracking Parameterized `type = ?` Queries
**Context:**  
The design spec notes ~21 `WHERE type = ?` queries. Task 1.3 focuses on literal comparisons (`type = '...'`).
- **Recommendation:** Add a `parameterizedReadCount: number` to `LaneCensus` (Task 1.6). Emitting the count and file list of `WHERE type = ?` in `index-lane-census.json` ensures dynamic queries are transparent and prevents blind spots from growing unnoticed.

---

### Q3: Phase 3 PR Breakdown
The plan leaves Phase 3 for later. For clarity of roadmap tracking, we recommend pre-specifying the 4 targeted follow-up PRs:

| PR | Title | Fix Target |
|---|---|---|
| **PR 3a** | `fix(metrics): emit repo on github_actions ci_run and enable DORA canary` | `connectors/github-actions-sync.ts` & `metrics/dora.canary.test.ts` |
| **PR 3b** | `fix(preflight): align workflowName and headBranch metadata in preflight check` | `preflight/preflight.ts` & `preflight/preflight.test.ts` |
| **PR 3c** | `fix(agents): attach detectMissingItemType to expert commit lane` | `agents/expert.ts` & `agents/expert.test.ts` |
| **PR 3d** | `fix(premortem): index opened_at_ms on PR sync or query item timestamps` | `connectors/github-sync.ts` & `agents/premortem.ts` |

---

## 4. Summary Table of Task Amendments

| Plan Task | Component | Action / Fix Required |
|---|---|---|
| **Task 1.1** | `sql-literals.ts` | Support double/single quoted SQL strings in addition to backtick templates. |
| **Task 1.3** | `read-sites.ts` | Add `TYPE_IN_CMP` regex to catch `WHERE type IN ('a', 'b')` queries. |
| **Task 1.4** | `read-sites.ts` | Update `JS_META_READ` regex to match `meta?.["key"]`, `metadata?.['key']`, and `meta['key']`. |
| **Task 1.5** | `writer-emissions.ts` | Handle shorthand properties (`{ foo }`) and quoted keys (`{ "foo": 1 }`) in metadata objects. |
| **Task 1.6** | `check-index-lane-coverage.ts` | Scope `metadata-key` matching to the query's `(service, type)` context; add `parameterizedReadCount`. |
| **Task 2.1** | `lane-coverage.ts` | Use granular per-service entries for cross-service types like `ci_run`. |
| **Task 2.3** | `check-index-lane-coverage.ts` | Enforce anti-stale check: fail if a `known-dead` entry's writer begins emitting the key. |

---

## 5. Conclusion

With the above regex and scoping refinements applied to Tasks 1.1, 1.3, 1.4, 1.5, and 1.6, the implementation plan is **ready for execution**.
