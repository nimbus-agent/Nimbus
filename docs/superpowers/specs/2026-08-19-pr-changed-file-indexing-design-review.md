# Review & Feedback: PR changed-file indexing Design

This document reviews [2026-08-19-pr-changed-file-indexing-design.md](./2026-08-19-pr-changed-file-indexing-design.md) and compiles open questions, suggestions, and potential improvements.

---

## 1. Questions & Clarifications

### Lifecycle of `local_file_id`

* **Handling deletions and untracking:** When the ownership pass runs and maps remote repo paths to local `graph_entity.id` values:
  * What happens if a local file is deleted? Does the ownership pass set `local_file_id` back to `NULL`?
  * What happens if a repository is untracked (deleted from workspaces)? Do we prune or update the `local_file_id` columns, or do we rely on cascade behavior?
  * *Suggestion:* Clarify that the ownership pass should nullify references to nonexistent `graph_entity.id` values to prevent dangling foreign key references, or design it such that untracking a workspace triggers a cascade reset of `local_file_id` for affected rows.

### Cleanup / Pruning of `pr_changed_file` and `pr_files_state`

* **Orphaned records:** When a PR or repo is pruned or deleted from the main database index, how are these tables cleaned up?
  * *Suggestion:* Define a foreign key constraint linking `(service, pr_external_id)` to the corresponding PR entity (e.g., `item` or `graph_entity`), using `ON DELETE CASCADE` to prevent storage leaks when items are pruned or database cleanup routines run.

### Negation SQL Query Patterns

* **Fail-Closed SQL Construction:** To ensure D2 ("uncovered PR is EXCLUDED from negation") is cleanly implemented, it would be beneficial to specify the canonical SQL template that W6-B should use.
  * *Example Template:*

    ```sql
    SELECT p.*
    FROM items p
    JOIN pr_files_state s 
      ON s.service = p.service 
     AND s.pr_external_id = p.external_id
    WHERE p.type = 'pr'
      AND s.truncated = 0  -- Fail-closed: exclude truncated list
      -- Positive checks or negation checks:
      AND NOT EXISTS (
        SELECT 1 
        FROM pr_changed_file f
        WHERE f.service = p.service
          AND f.pr_external_id = p.external_id
          AND f.path LIKE 'tests/%'
      );
    ```

---

## 2. Recommended Improvements & Suggestions

### Batch Operations for Sync Write Performance

* **Writing efficiency:** Since PR file listings can contain up to the cap (e.g., 300 files), syncing a batch of PRs could lead to thousands of row inserts in `pr_changed_file` per sync tick.
  * *Suggestion:* Ensure the implementation uses bulk/batch inserts (`dbExec` / `dbStmtRun` with parameterized statement execution or chunked JSON inserts) rather than single-row insertions to minimize SQLite transaction overhead.

### Pagination Parameters for Forge APIs

* **Reducing API footprints:**
  * *GitHub:* The `/repos/{owner}/{repo}/pulls/{pull_number}/files` endpoint defaults to 30 items per page. Setting `per_page=100` reduces the number of API calls significantly for PRs touching more than 30 files.
  * *GitLab / Bitbucket:* Similar pagination parameters should be explicitly configured in the client mappings to ensure pagination limit matches the `MAX_FILES_PER_PR` cap efficiently.
