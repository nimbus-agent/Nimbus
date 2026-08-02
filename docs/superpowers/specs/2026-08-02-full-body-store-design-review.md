# Review & Feedback: Full-body Store Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of the full-body store specified in [2026-08-02-full-body-store-design.md](./2026-08-02-full-body-store-design.md).

---

## 1. Title Derivation Footgun in Other Connectors

### Issue: Broadening the Scope of the Title Derivation Check

The design identifies a critical footgun where Slack, Teams, and Discord derive the item title from the same variable that holds the preview via `shortIndexedMessageTitleFromPreview`. If widened, the whole body feeds into the title generator.

While the design notes this for those three chat connectors, other prose connectors (e.g., Zoom transcripts, Obsidian, Linear, Jira, GitHub issues) might also have similar inline title derivations or metadata extraction logic that assumes `body` is short or uses the same variable.

### Recommendation

* **Comprehensive Audit:** During the implementation of the second rollout PR (connector migrations), run a grep search or static audit across all migrated prose connectors to verify that no title, tag, or metadata field is derived directly from the un-sliced `body` variable.
* **Standardize Helper:** Introduce a helper or enforce a clean separation of variables where `title` is resolved first from the raw source metadata or a strictly-capped slice, and `body` is passed separately.

---

## 2. Optimizing `nimbus index rebody` with `--only-truncated` Default

### Issue: Rate Limit and Quota Starvation during Backfills

The design specifies that `nimbus index rebody` drives a re-sync by clearing watermarks for prose types. If it re-fetches every single item (even those that are already complete, i.e., those whose source text was under 512 characters and thus not actually truncated), it will waste significant API rate limits and network bandwidth.

### Recommendation

* **Default to Truncated-Only:** Make `--only-truncated` (targeting rows where `body_complete = 0`) the default execution mode for `nimbus index rebody`.
* **Add `--force` Flag:** Provide a `--force` flag to allow re-fetching even for items marked as `body_complete = 1` if the user wants to ensure full parity or recover from corrupted local data.

---

## 3. Implicit Completeness for Small Items during Migration

### Issue: Migrated Short Items Marked as Truncated

In the V48 migration:

```sql
ALTER TABLE item ADD COLUMN body TEXT;
ALTER TABLE item ADD COLUMN body_complete INTEGER NOT NULL DEFAULT 0;
UPDATE item SET body = body_preview;
```

Every single migrated row gets `body_complete = 0`. However, any item with a `body` length strictly less than 512 characters is *guaranteed* to be complete, because it could not have been clamped at the 512-character boundary in V47. Marking them as `body_complete = 0` means a subsequent `rebody` sweep will unnecessarily target them for re-fetching.

### Recommendation

* **Smart Migration Flagging:** In the V48 migration script, initialize `body_complete` by checking the length of the migrated text:

  ```sql
  UPDATE item SET 
    body = body_preview,
    body_complete = CASE WHEN length(body_preview) < 512 THEN 1 ELSE 0 END;
  ```

  This immediately marks all historically short items (e.g., brief Slack messages, short tasks) as complete, excluding them from expensive backfill sweeps.

---

## 4. FTS5 Index Size and Performance Mitigations

### Issue: SQLite Database Inflation

Widening the FTS5 indexed content from 512 bytes to 16 KiB (a 32x potential increase per prose row) will significantly inflate the size of the SQLite database file due to shadow tables created by FTS5 (`item_fts_data`, `item_fts_idx`). FTS5 keyword indexing can lead to query latency spikes on low-resource machines if the index size exceeds the SQLite page cache.

### Recommendation

* **FTS5 Option Tuning:** Consider configuring FTS5 with `detail=column` or prefix options if storage/memory overhead becomes an issue on target user machines.
* **Database Size Telemetry:** Include FTS index size or table sizes in the output of `nimbus index metrics` to track database growth post-rollout.

---

## 5. Unicode Boundary and Surrogate Pair Safety during Clamping

### Issue: Splitting Multi-Byte/Surrogate Characters

When clamping string content to `BODY_MAX_PROSE` (16,384 characters), using a simple JavaScript `.slice(0, 16384)` can split a surrogate pair (e.g., emojis or complex Unicode characters) at the boundary, resulting in invalid UTF-16 strings in the DB or JSON-RPC responses.

### Recommendation

* **Surrogate-Safe Slicing:** Use a helper function for string clamping that ensures surrogate boundaries are respected (e.g., using `Array.from(str).slice(0, limit).join('')` or checking if the character at the boundary is a high surrogate before slicing).
