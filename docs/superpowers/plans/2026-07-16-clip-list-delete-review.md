# Plan Review — `nimbus clip list` + `nimbus clip delete` Implementation

**Date:** 2026-07-16
**Target:** [2026-07-16-clip-list-delete.md](./2026-07-16-clip-list-delete.md)

## Open Questions & Suggestions

### 1. Robust SQLite `json_each` queries on Malformed JSON

* **Problem:** In Task 1, Step 3, the SQL query for tag filtering is:

  ```sql
  SELECT item.* FROM item, json_each(item.metadata, '$.tags') ...
  ```

  If `item.metadata` contains a row with malformed (invalid) JSON (as created in the test `"tolerates malformed metadata (tags empty, never throws)"`), SQLite's `json_each` function will raise a query execution error and abort. Even though the test updates the row to invalid JSON, that test runs `clip.list` without a tag filter (which uses `buildItemListSql` and skips `json_each`). However, if a user filters by tag while any invalid JSON metadata row exists in the DB, the entire listing operation will crash.
* **Suggestion:** Make the `json_each` call resilient by checking the validity of the JSON or falling back. For example:

  ```sql
  SELECT item.* FROM item, json_each(
    CASE WHEN json_valid(item.metadata) THEN item.metadata ELSE '{"tags":[]}' END,
    '$.tags'
  )
  WHERE item.type = 'web_clip' AND json_each.value = ?
  ORDER BY item.modified_at DESC LIMIT ?
  ```

  This ensures that invalid metadata values are safely treated as empty tag objects without raising SQLite errors.

### 2. Missing DB / Fail-Soft Behavior Mismatch

* **Problem:** The design spec states:
  > *Index absent (no localIndex at boot — abnormal): list returns an empty list; delete returns an error the CLI surfaces as "Clip index unavailable.".*
  
  However, Task 2, Step 3 implements `clip.delete` like this when `db` is undefined:

  ```ts
  if (deps.db === undefined) return { kind: "hit", value: { deleted: 0, matched: 0 } };
  ```

  This returns a successful IPC response `{ deleted: 0, matched: 0 }`, and the test validates this. Under this plan, the CLI will output `Deleted 0 clips.` or `0 clips would be deleted.` instead of surfacing the specified `Clip index unavailable.` error.
* **Suggestion:** Align the implementation with the specification. In Task 2, Step 3, have `clip.delete` throw an error (or return a structured rejection) when `deps.db === undefined`:

  ```ts
  if (deps.db === undefined) {
    throw new Error("Clip index unavailable.");
  }
  ```

  Update the test and CLI commands to handle this error appropriately.

### 3. Mutual Exclusion of URL Target and `--all`

* **Question:** What happens if a user accidentally runs `nimbus clip delete https://google.com --all`?
* **Suggestion:** In `runClipDelete` or `clip.delete`, check if both arguments are specified and throw a validation/usage error to prevent accidentally deleting all clips when the user specified a specific URL target.
