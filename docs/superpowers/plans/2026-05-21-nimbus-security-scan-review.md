# Review: `nimbus security scan` Implementation Plan

Overall, the plan is extremely well-structured, adhering perfectly to the architectural principles (Phase 5, T4 idioms), maintaining strict security boundaries (I5, I7 invariants), and providing comprehensive test coverage (unit + e2e). 

Here are some open questions, suggestions, and potential improvements to consider before or during implementation.

## 1. Performance: Filtering `metadata_only` in SQL
**Observation:** In Task 3 (`security-rpc.ts`), the code iterates over all items in the database and yields them to JS, including the potentially large `body_preview` column. Then it filters out items if their connector is at `metadata_only` depth:
```typescript
if (depth === "metadata_only") {
  items_skipped_depth += 1;
  skipped_services.add(item.service);
  continue;
}
```
**Suggestion:** Loading large `body_preview` strings into V8 memory only to discard them in JS is inefficient and could cause memory spikes if the index is large. It would be much more performant to filter out `metadata_only` items directly in the SQL query using a `JOIN` with `sync_state`, or by filtering them via a subquery. You can determine the skipped connectors and their item counts using a separate `COUNT(*)` query.

## 2. Completeness of `skipped_connectors`
**Observation:** Currently, `skipped_connectors` is populated by discovering items that belong to a `metadata_only` connector during the `item` iteration:
```typescript
skipped_services.add(item.service);
```
**Issue:** If a connector is configured as `metadata_only` but has synced **0 items** so far, it will not appear in the `skipped_connectors` list in the CLI output. 
**Suggestion:** Build the `skipped_connectors` list directly from the `depthMap` (derived from the `sync_state` table). Any connector in `sync_state` with `depth === "metadata_only"` should be reported as skipped, regardless of whether it currently has indexed items.

## 3. Context Snippet Edge Case: Surrogate Pairs (Unicode)
**Observation:** In `buildContextSnippet` (Task 1), the text is sliced using strict numerical offsets:
```typescript
const start = Math.max(0, offset - CONTEXT_RADIUS);
const end = Math.min(body.length, offset + length + CONTEXT_RADIUS);
const before = body.slice(start, offset);
```
**Issue:** `String.prototype.slice` operates on UTF-16 code units. If `offset - CONTEXT_RADIUS` happens to land exactly in the middle of a 4-byte Unicode character (a surrogate pair, like an emoji), the resulting string will contain an invalid half-character (often rendered as ). 
**Suggestion:** This is a minor visual glitch for terminal output and might be perfectly acceptable for v1. However, to be robust, you could snap the slicing bounds to valid character boundaries, or simply accept the rare terminal rendering artifact.

## 4. `isSecurityScanResult` Validation
**Observation:** In the CLI (Task 6), the type guard `isSecurityScanResult` verifies that `v.findings` and `v.skipped_connectors` are arrays:
```typescript
Array.isArray(v.findings) && Array.isArray(v.skipped_connectors)
```
**Suggestion:** It does not validate the shape of the objects inside these arrays. Since the CLI is communicating locally with its own trusted Gateway over IPC, this shallow check is likely sufficient and keeps the code lightweight. It's just something to be aware of if the IPC contract evolves.

## 5. Overlapping Pattern Ranges (Minor Confirmation)
**Observation:** The plan mentions that `sk-ant-` patterns match first, and the pure scanner does not deduplicate cross-pattern overlaps. 
**Confirmation:** Looking closely at the regexes, `openai_api_key` is `/\bsk-[A-Za-z0-9]{20,}\b/g`. Since `A-Za-z0-9` does not include hyphens, an Anthropic key (`sk-ant-...`) will **not** trigger the OpenAI regex. Therefore, overlap is naturally avoided between these two specific patterns, which is a neat detail!
