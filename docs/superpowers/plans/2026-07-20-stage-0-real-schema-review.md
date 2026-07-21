# Stage 0 (Revised) Implementation Plan Review — Feedback, Suggestions, and Open Questions

This document reviews the implementation plan for **Stage 0 (Revised) — Seal the Narrow Waist: Implementation Plan** ([2026-07-20-stage-0-real-schema.md](./2026-07-20-stage-0-real-schema.md)).

---

## 1. Open Questions & Technical Clarifications

### Q1.1: Validation of properties not explicitly parsed by `rowToItem`

* **Observation:** The plan updates `validateQueryItems` to strip/ignore or explicitly validate a strict list of fields matching `IndexedItem`.
* **Question:** If the database row in V3 returns additional keys that are not explicitly present on the client's `IndexedItem` (e.g. `body_preview`, `author_id`, `synced_at`, `pinned`), will the new validator silently strip them out (because it constructs a new `item` object and only copies selected keys) or will they pass through?
* **Impact:** The implementation of `validateQueryItems` in Task 3, Step 4 constructs a new object and only maps explicit properties. This is a good design as it cleanly strips any leaked SQLite columns, but we should make sure that no other tools or scripts count on these raw keys from the diagnostics RPC endpoint.

### Q1.2: Client Package Publishing Dependencies

* **Observation:** Task 5 in `nimbus-vscode` states: "Depends on: Task 4 published."
* **Question:** Since `nimbus-client` is published as `@nimbus-dev/client@0.6.0` to npm, how do we handle local development and testing of `nimbus-vscode` before the npm package is officially published?
* **Recommendation:** Under *Sequencing* in the spec, it notes that `nimbus-client` supports a local workflow. The plan should explicitly suggest using `npm link` or `yalc` to link the local `@nimbus-dev/client` development build to `nimbus-vscode` during the implementation phase so that the developer doesn't get blocked waiting for CI release pipelines.

---

## 2. Suggested Improvements & Refinements

### Suggestion 2.1: Add a regression test for `LocalIndex.listItems()` directly

* **Context:** In Task 2, `listItems()` is added to `LocalIndex`.
* **Suggestion:** We should add a unit test in `packages/gateway/src/index/local-index.test.ts` that queries `listItems()` directly with limits and type filters to verify it returns `IndexedItem[]` properly mapped via `rowToItem`, before verifying it through the JSON-RPC diagnostics boundary.

### Suggestion 2.2: Add a validation test in VS Code for unrecognized fields

* **Context:** In Task 5, we remove the `ITEM_TYPES` union check.
* **Suggestion:** Add a specific test case in `test/unit/index.test.ts` where a field value is completely missing or malformed to verify that `parseIndexRow` gracefully returns `undefined` (or fallback values) instead of failing to render the tree node entirely.
