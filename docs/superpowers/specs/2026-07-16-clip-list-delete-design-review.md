# Design Review — `nimbus clip list` + `nimbus clip delete`

**Date:** 2026-07-16
**Target:** [2026-07-16-clip-list-delete-design.md](./2026-07-16-clip-list-delete-design.md)

## Open Questions & Suggestions

### 1. Tag Filtering + SQL Pagination (Limit) Bug
* **Problem:** The design states: `optional in-memory tag filter (applied after the SQL)`. Under the hood, `clip.list` uses `buildItemListSql` which appends a `LIMIT` constraint (default 50) directly to the SQL query. If tag filtering is applied in memory *after* the query is executed, you will get incorrect pagination or empty lists. For example: if the last 50 clips do not have the tag `rust`, but the 51st clip does, the query returns 50 clips, the filter trims it to 0, and the CLI shows `No clips match tag "rust"`, despite a matching clip existing in the database.
* **Suggestion:** Filter by tag in the database layer. Since tags are stored as a JSON array within the `metadata` column (e.g., `{"tags":["rust","async"]}`), you can utilize SQLite's JSON extension functions in the query. For example:
  ```sql
  SELECT item.* FROM item, json_each(item.metadata, '$.tags')
  WHERE item.type = 'web_clip' AND json_each.value = ?
  ORDER BY modified_at DESC LIMIT ?
  ```
  Alternatively, if you must filter in-memory, you cannot apply the `LIMIT` inside the SQL query; instead, you would have to load *all* clips of type `web_clip` into memory, filter by tag, and then apply the limit. Database-level filtering is significantly more performant and robust.

### 2. Graph Database Entity Cleanup on Delete
* **Problem:** In the architecture section, the design suggests finding matching items by canonical URL or `--all`, and then "deleting each."
* **Suggestion:** Make sure the implementation uses the existing helper [deleteItemByPrimaryKey](file:///C:/gitrep/Nimbus/packages/gateway/src/index/item-store.ts#L159-L168) for each resolved ID. This function automatically invokes `deleteGraphEntitiesForItemKeys` to clean up relationships in the relationship graph. Doing raw SQL deletes (`DELETE FROM item ...`) directly would leave orphaned entities in the graph store.

### 3. Cascading Embedding & Vector Cleanup (Confirmed Strength)
* **Design Audit:** When an item is deleted from the `item` table, its corresponding embeddings and SQLite-vec rows must be cleaned up.
* **Result:** No manual database cleanup is needed here. The schema defined in [embedding-v6-sql.ts](file:///C:/gitrep/Nimbus/packages/gateway/src/index/embedding-v6-sql.ts) already specifies `ON DELETE CASCADE` for the foreign key on `embedding_chunk.item_id`, and includes an `AFTER DELETE` trigger (`embedding_chunk_ad_delete_vec384`) to clean up vector rows in the virtual table `vec_items_384`. The design's reliance on database-level triggers for FTS and embeddings is correct and secure.

### 4. Input Target Validation in `clip delete`
* **Question:** What happens if the user runs `nimbus clip delete ""` or `nimbus clip delete " "`?
* **Suggestion:** Add validation checks for the delete target string. If the target is empty, blank, or canonicalizes to an invalid/empty URL, the command should return early with `Deleted 0 clips.` or a validation error, rather than querying `SELECT id FROM item WHERE canonical_url = ''` which could match records with malformed URLs.

### 5. CLI Options Validation
* **Suggestion:** Ensure validation is added in the CLI command handler for options:
  * Validate `--limit` is a positive, finite integer. If the user runs `nimbus clip list --limit invalid`, it should fall back to the default `50` or print an option validation error rather than passing `NaN` or a bad string to the IPC call.

### 6. Enrichment of `--json` Output
* **Suggestion:** In the JSON output format (`--json`), include other useful metadata fields stored in the DB if available, such as `wordCount` (e.g. `{ id, title, url, clippedAt, tags, mode, wordCount }`). This makes scripting and integration even more powerful for developers using the CLI output.

## Alignment with Invariants
* **Invariants (I29/D22):** The design correctly notes that deleting a local-index item does not constitute outbound egress, so it doesn't need to pass through the egress ledger or HITL consent gate (matching connector sync deletions).
* **Invariants (I30/I2):** Pair/status/revoke do not touch the DB; the design maintains correct separation of roles and continues to keep clipper token verification out of the local index domain.
