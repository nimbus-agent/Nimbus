# Review & Feedback: Notion + Confluence Full-Body Indexing Design

This document contains a structured review, suggestions, improvements, and open questions regarding the design of Notion and Confluence full-body indexing specified in [2026-08-03-notion-confluence-full-body-design.md](./2026-08-03-notion-confluence-full-body-design.md).

---

## 1. Re-fetching Large Pages Exceeding `BODY_MAX_PROSE` (Skip-if-fresh Defect)

### Issue

The design specifies the skip-if-fresh local check as:

```text
body_complete = 1 AND modified_at == <this page's last_edited_time>
  -> skip the block fetch entirely
```

However, any Notion or Confluence page that genuinely exceeds the `BODY_MAX_PROSE` limit (16 KiB) will have its `body_complete` column set to `0` in the database (since `raw.length > cap`).

Because `body_complete` is `0`, the skip-if-fresh check will **always fail** on subsequent sync passes, even if the page has not been modified at all. This means every single sync pass will re-fetch the entire block tree of all large pages, wasting rate limits/budget on Notion and bandwidth on Confluence.

### Recommendation

Refine the skip-if-fresh logic to also skip pages that have reached the hard storage cap:

```ts
const isAlreadyCached = (row.body_complete === 1 || (row.body && row.body.length >= BODY_MAX_PROSE))
  && row.modified_at === lastEditedTime;
```

This avoids re-fetching stable pages that are already maxed out at 16 KiB.

---

## 2. Notion Container Block Recursion and Nested List Items

### Issue

The design states:
> Recurse **only** into pure container blocks — `column_list`, `column`, `toggle`, `synced_block` — and only when `has_children` is true, to a maximum depth of 2.

In Notion, bulleted or numbered list items (`bulleted_list_item`, `numbered_list_item`) are not "pure container blocks" because they carry their own text content. However, they frequently have nested children (e.g., sub-bullets/sub-lists). Under the current design, if these are not included in the recursion list, sub-bullets or nested list hierarchies will be skipped entirely.

### Recommendation

Allow recursion into list items and callouts if they have children, or clarify if nested lists are explicitly excluded. If they are allowed to recurse, we must collect their own text *and* append the text of their children recursively.

---

## 3. Search Loop Overhead on Pinned Watermark

### Issue

For Notion, the design suggests pinning the search watermark during budget-exhausted passes and relying on the 5-minute scheduler tick to resume.

If a workspace has 10,000 pages and a sync budget of 200 pages, it will take 50 passes to complete the backfill. If the watermark is pinned, each of the 50 passes must start the `/v1/search` paginated walk from the very beginning. By the 40th pass, the sync must walk through and discard 8,000 search results before reaching the 200 un-fetched pages. This causes significant search request overhead.

### Recommendation

Consider storing a temporary "backfill cursor" or page token in a runtime state, or allow advancing the search watermark while maintaining a separate queue/list of pending pages to fetch bodies for. If that is too complex, document the expected API request amplification for large workspaces so operators are aware.

---

## 4. Confluence Batch Size Auto-Tuning

### Issue

Reducing the Confluence batch size from 50 to 25 is a reasonable precaution against payload rejection or truncation due to fatter XHTML bodies. However, for spaces with extremely large page sizes (or heavy attachments/metadata), even 25 might occasionally trigger timeout or payload limits.

### Recommendation

Ensure that if a batch request fails with a timeout or 502/504 error, the sync code can gracefully fallback or retry with a smaller batch size (e.g., 10 or 5) for that batch rather than failing the entire sync process.
