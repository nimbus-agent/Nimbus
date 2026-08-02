# Review & Suggestions: Full-Body Store (V48) Implementation Plan

This document contains a structured review, suggestions, improvements, and open questions regarding the implementation plan specified in [2026-08-02-full-body-store.md](file:///C:/gitrep/Nimbus/.claude/worktrees/full-body-store/docs/superpowers/plans/2026-08-02-full-body-store.md).

---

## 1. Syncing Design Review Improvements with the Plan

### The Issue

A design review was generated in [2026-08-02-full-body-store-design-review.md](file:///C:/gitrep/Nimbus/.claude/worktrees/full-body-store/docs/superpowers/specs/2026-08-02-full-body-store-design-review.md) containing critical feedback, specifically regarding:

1. Smart flagging of `body_complete` for short historical items (where `length(body_preview) < 512`) during the V48 migration.
2. An audit for inline title derivations in non-chat prose connectors (e.g. Linear, Jira, GitHub) similar to the Slack/Discord footgun.

These adjustments are not yet reflected in the task descriptions of the implementation plan.

### Recommendation

* **Task 2 (Migration):** Update the migration query in Step 3 to conditionally set `body_complete` to `1` if the existing `body_preview` is under 512 characters:

  ```sql
  UPDATE item SET body = body_preview, body_complete = CASE WHEN length(body_preview) < 512 THEN 1 ELSE 0 END;
  ```

* **Task 10 (Issues):** Add a verification checklist step to ensure that changing `bodyPreview` to `body` in Linear, Jira, GitHub, Bitbucket, and Snyk does not feed the unsliced body into any title-derivation logic in those files.

---

## 2. Check for Potential Schema/Model Mismatch in `upsertIndexedItem`

### The Issue

In Task 3, `IndexedItemBodyInput` is defined as:

```ts
export type IndexedItemBodyInput =
  | { bodyPreview?: string; body?: undefined }
  | { body: string; bodyPreview?: undefined };
```

And it is intersected with the `row` parameter of `upsertIndexedItem`.
However, some existing calls to `upsertIndexedItem` or wrapper sync functions might pass the row parameters using object spreads or as a raw object where both fields might technically be `undefined` or optional properties typing-wise. If TypeScript strict mode is enabled, intersection types on discriminated unions with optional undefined parameters can sometimes cause compilation issues depending on how TS infers the excess property checks.

### Recommendation

Ensure that we test these types with the compilation gates early in Task 3. If compiler errors arise, consider relaxing the strict discriminated union to a simple interface with both optional, and handle mutual exclusivity with a runtime check or runtime assertion in test:

```ts
export type IndexedItemBodyInput = {
  bodyPreview?: string;
  body?: string;
};
```

And throw an error in dev or test if both are defined.

---

## 3. Watermark Resets and Sync Overheads in `rebody`

### The Issue

In Task 14, the plan notes:
> There is deliberately no `--only-truncated` mode. A sync fetches by page and time window, not by item id, so the flag could suppress writes (free) while every API call still happened...

While this is true for event-based/stream-based syncs (like Slack or Gmail), for resource-based connectors like Notion, Confluence, and Jira, resetting the watermark triggers a full synchronization scan of all pages/tickets. For accounts with tens of thousands of items, a full sync to fetch missing bodies is extremely heavy.

### Recommendation

As a future optimization path, note in the comments of `index-rebody-rpc.ts` that if single-resource fetching capability is added to the connector SDK in a later phase, `rebody` should target individual resource endpoints by item IDs where `body_complete = 0`, instead of invoking a full synchronization loop.
