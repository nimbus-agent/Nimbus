# Review & Suggestions: Notion + Confluence Full-Body Indexing Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-08-03-notion-confluence-full-body.md](./2026-08-03-notion-confluence-full-body.md).

---

## 1. Table Block Text Extraction Support

### Issue

In Task 4, the helper function `notionBlockOwnText` is implemented as:

```ts
export function notionBlockOwnText(block: Record<string, unknown>): string {
  const type = stringField(block, "type");
  if (type === undefined) {
    return "";
  }
  const payload = asRecord(block[type]);
  if (payload === undefined) {
    return "";
  }
  return notionRichTextToPlain(payload["rich_text"]);
}
```

While this works for the majority of text-bearing blocks (paragraphs, headings, callouts, lists, toggles), Notion tables are structured differently. A `table_row` block does not have a `rich_text` field; instead, it contains a `cells` property, which is a two-dimensional array of rich-text arrays (`cells: Array<Array<RichText>>`).

Under the current plan, table cells will yield `""` and their text content will be entirely ignored during the walk.

### Recommendation

Extend `notionBlockOwnText` to support `table_row` blocks by extracting text from the `cells` array:

```ts
  if (type === "table_row") {
    const cells = payload["cells"];
    if (Array.isArray(cells)) {
      return cells
        .map(cell => notionRichTextToPlain(cell))
        .filter(t => t !== "")
        .join(" | "); // Format cells with a separator
    }
  }
```

This ensures pages structured around tables still yield useful definition/decision text for the downstream glossary and decisions agents.

---

## 2. Preventing Endless Redos on Watermark Reset

### Issue

In Task 5, when the budget runs out, `budgetStopped` is set to `true`, and the watermark is pinned:

```ts
const nextW = budgetStopped ? watermark : maxEdited === "" ? watermark : maxEdited;
```

For a workspace with thousands of pages, the scheduler will trigger a re-sync every 5 minutes. On each pass, the Notion `/v1/search` endpoint will return pages from the pinned watermark timestamp.

If there are many new pages modified *after* the watermark, but we process them in pagination order, and the budget runs out, the watermark remains pinned to the old position. This is correct because we haven't processed all pages up to the newest watermark. However, it means we will retrieve pages we *have* already successfully indexed on this pass again on the next pass, relying on the `selectItemBodyFetchState` skip-if-fresh check to avoid N+1 requests.

While this protects the Notion API from block walks, the search API itself is still paginated and traversed.

### Recommendation

Add a log line or telemetry event when `budgetStopped` occurs so the user/admin console can observe that a backfill is actively in progress and converging (e.g., `notion sync budget exhausted; watermark pinned for backfill convergence`).

---

## 3. Depth Limitation Clarification for Nested Callouts / List Items

### Issue

The depth limit is set to `2`.

* Depth 1: The page's own children.
* Depth 2: Children of container blocks.

If a page has a structure like `Toggle -> Bulleted List -> Sub-bulleted List`, the `Sub-bulleted List` is at Depth 3. It will hit the depth cap and be marked as `outcome: "capped"`. While this is safe, it means a lot of standard nested list hierarchies will be permanently marked as `capped` and skipped on future passes.

### Recommendation

Confirm if `MAX_DEPTH = 2` is a hard requirement for performance, or if it can be bumped to `3` safely. A depth of `3` would cover typical nested lists/toggles without significantly increasing risk, especially since we have the `NOTION_BODY_REQUESTS_PER_PAGE_MAX = 10` cap to protect against runaways.
