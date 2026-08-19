# Design Review: Brief index widening (2026-08-19)

Below are comments, questions, and suggested improvements for the `2026-08-19-brief-index-widening-design.md` specification.

## Open Questions & Clarifications

1. **Token Budget & Chunk Size Limits**
   * **Question:** Widening the search to pull requests, builds, and code files means the content chunk sizes (`contextChunks: 2` per hit, up to 8 hits) might be significantly larger than web clips. Do we have constraints/truncation logic to ensure a single massive PR/build log hit does not exhaust the model's prompt token limit?

2. **Result Ranking & Prioritization**
   * **Question:** When searching across all indexed types without filtering, how does the hybrid ranker rank them? If a query matches 20 items (some clips, some issues, some builds), does the ranking algorithm naturally bias towards certain types, or is it purely semantic/keyword score-based? Should there be a fallback ratio (e.g., at least 2 clips, at least 2 issues) to avoid one type dominating the 8 slots?

3. **Prompt Enrichment (`itemType`)**
   * **Question:** Regarding Decision 4: If the synthesis test demonstrates that passing `itemType` improves attribution, what schema structure will it take? Feeding type information is likely highly beneficial (e.g., distinguishing a Jira issue from a git commit allows the LLM to write cleaner syntheses like "According to PR #12...").

## Suggested Improvements

1. **Robust Parser/Validator Resiliency**
   * **Suggestion:** Ensure the client validation (e.g., Zod schema or JSON parsing) explicitly maps `itemType` as an optional string that accepts *any* arbitrary value. Since other connectors can be added to the gateway independently, the client shouldn't crash if it encounters a novel type like `itemType: "slack_message"`.
