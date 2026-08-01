# Review & Suggestions: `nimbus decisions` Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-08-01-nimbus-decisions.md](./2026-08-01-nimbus-decisions.md).

---

## 1. Schema and Indexing Discrepancies between Spec and Plan

### The Issue
The implementation plan introduces the `priority` column (`REAL NOT NULL DEFAULT 0`) in the `decision_record` schema (Task 1) and adds `idx_decision_pending_priority` to optimize candidate retrieval.
However, this column and its associated indexing are absent from the original design specification.

### Recommendation
Ensure the design specification is updated to reflect this schema change, as implementation plans and specs should remain synchronized to prevent developers or auditors from referencing outdated schemas.

---

## 2. Inefficient Graph Traversal in `matchesRepo` (Task 12)

### The Issue
In Task 12, `matchesRepo` traverses graph relations using:
```sql
SELECT repo.label AS label
  FROM graph_relation r
  JOIN graph_entity repo ON repo.id = r.to_id AND repo.type = 'repository'
 WHERE r.from_id IN (${ph})
```
This query does not constrain the relationship type `r.type`. While a PR or commit typically only links to a repository via a relation of type `belongs_to` or similar, leaving `r.type` unconstrained could cause false repository matches if other relationship types are introduced in future phases.

### Recommendation
Filter `r.type` explicitly based on the relation type emitted by the repository populator (e.g., `belongs_to` or `in_repository`):
```sql
SELECT repo.label AS label
  FROM graph_relation r
  JOIN graph_entity repo ON repo.id = r.to_id AND repo.type = 'repository'
 WHERE r.from_id IN (${ph})
   AND r.type = 'belongs_to'
```

---

## 3. Potential Timeout in FTS Query (Task 6)

### The Issue
In Task 6 (`decision-corroborate.ts`), the ADR matching queries *all* long-form pages in the database up to a limit of 500:
```sql
SELECT id, title, url, modified_at FROM item
 WHERE (service || ':' || type) IN ('notion:page','confluence:page','obsidian:obsidian_note')
 LIMIT 500
```
It then iterates over them in memory using `tokenOverlap` and `ADR_TITLE_RE.test(a.title)`.
In a large index where a team has hundreds of Notion/Confluence pages, scanning 500 items and running regex/token matching in JS for *each* extracted decision on *every* corroboration pass could become a CPU bottleneck.

### Suggestions
1. **Database-level FTS filter**: If possible, query the `item_fts` virtual table using FTS5 to search for pages matching "ADR", "decision", etc., first:
   ```sql
   SELECT i.id, i.title, i.url, i.modified_at 
     FROM item i
     JOIN item_fts f ON f.rowid = i.rowid
    WHERE (i.service || ':' || i.type) IN ('notion:page','confluence:page','obsidian:obsidian_note')
      AND f.title MATCH 'ADR OR decision'
    LIMIT 50
   ```
2. This pushes the regex matching down to the SQLite engine, drastically reducing the number of rows returned to the JS runtime for token overlap checks.
