# Plan Review: Phase 6 Slice 6c — Tribal-Knowledge Extraction (implementation plan)

**Review Date:** 2026-06-12  
**Reviewer:** Antigravity (AI Coding Assistant)  
**Target Plan:** [2026-06-12-phase6-slice6c-tribal-knowledge.md](./2026-06-12-phase6-slice6c-tribal-knowledge.md)

---

## 1. Loop Prevention & Bot Self-Filtering

### 1.1 Preventing Bot Messages from Triggering the Watcher

- **Observation:** Task 8 widening of `slack-socket-adapter.ts` handles plain messages (`addressedToBot: false`) by checking `subtype` and `bot_id` to skip bot messages.
- **Risk:** In Teams or some Slack integrations, messages sent by the Nimbus bot itself might not have a `subtype` or `bot_id` if they are posted via webhooks or other routes, or the user ID matches the bot's own client ID. If the bot's own messages are ingested by `is-question.ts`, and the bot happens to quote or repeat a question, it could cause an infinite feedback loop of suggestions and ingestion.
- **Suggestion:**
  - In `tribal-watcher.ts` or `slack-socket-adapter.ts`, verify the author `userId` / `user` does not match the Nimbus bot's own user ID.
  - Specifically, obtain the bot's user ID at boot and explicitly filter it out in the normalizer or the watcher.

---

## 2. SQLite Metadata Queries & Recall Performance

### 2.1 Fetching Channel ID from JSON Metadata

- **Observation:** Task 5 uses `recall` which queries the `item` table to find similar questions. Since `item` does not have a `channel` column, the channel ID is stored inside `metadata.channel`.
- **Question:** How will `recall` perform the channel-allowlist query efficiently?
- **Suggestion:**
  - Ensure the SQL query in the production `recall` implementation uses SQLite's JSON path features (e.g., `json_extract(metadata, '$.channel') = ?`) to query/filter by channel directly in SQLite instead of pulling all hits into memory and post-filtering them.
  - Adding an index on `json_extract(metadata, '$.channel')` if the performance on a large `item` database becomes a bottleneck, or just documenting that we filter the top-N embedding search results in memory.

---

## 3. Notion API Children Block Parsing

### 3.1 Formatting of Markdown to Notion Blocks

- **Observation:** In Task 14, `notion_kb_append` will post synthesized answers to Notion. Synthetic answers contain Markdown which needs translation to Notion's Block JSON format.
- **Risk:** A naive paragraph splitter might fail or throw an API error if the body markdown contains headers, bullet points, or citation links that Notion does not accept in standard text format.
- **Suggestion:**
  - Include a minimal but robust markdown inline-lexer/parser in `notion_kb_append` or leverage any existing formatting helpers in the `packages/mcp-connectors/notion/` package.
  - Ensure code blocks and bullet points are mapped to Notion's `code` and `bulleted_list_item` block types respectively to maintain readable KB layout structure.

---

## 4. Static Invariant Validator Scope

### 4.1 Invariant D19 and Connector Locations

- **Observation:** Task 18 implements the `checkTribalKbWriteInvariant` static checker in `check-nimbus-invariants.ts`.
- **Question:** Does the checker scan files under `packages/mcp-connectors/`?
- **Suggestion:**
  - If the script `check-nimbus-invariants.ts` runs over the entire repository (including connector subpackages), the connector definition sites (`packages/mcp-connectors/notion/src/server.ts` and `packages/mcp-connectors/confluence/src/server.ts`) will trigger D19 violations unless added to `TRIBAL_KB_WRITE_ALLOWED`.
  - Verify if the workspace audit script scope is gateway-only or repository-wide, and proactively whitelist the connector implementation files if required.

---

## Dispositions (2026-06-12, plan author)

All 4 points **accepted (FIX)**; one sub-item (the json_extract expression index) deferred YAGNI. Plan
updated in `2026-06-12-phase6-slice6c-tribal-knowledge.md`.

| # | Disposition | Resolution in plan |
|---|---|---|
| **1.1 Bot self-filter / loop** | **FIX** | Added `botUserIds: ReadonlySet<string>` to `TribalWatcherDeps` (Task 7) and a first-line guard in `ingest` (`if (botUserIds.has(msg.userId)) return`) — the bot never ingests its own suggestion posts. Boot (Task 11) sources the ids from the chatops bot identity (Teams bot app id + Slack bot user id). Added a watcher test for it. The Slack normalizer's existing `subtype`/`bot_id` skip (Task 8) remains the primary Slack guard; this is cross-platform defense-in-depth. *Real risk — a suggestion quotes the question text, so without this a bot post could re-enter the pipeline.* |
| **2.1 JSON channel filter** | **FIX (+ DEFER index)** | The production `recall` now filters channels **in SQL**, not in memory: extend `vectorSearchChunks` with an optional `metadataChannelIn?` param appending `AND json_extract(i.metadata,'$.channel') IN (…)` (Task 11 Step 0 + vec-store unit test). This avoids watched-channel hits being pushed out of top-N by post-filtering — a correctness win, not just perf. **Deferred** the `json_extract` expression index as YAGNI (the KNN already bounds candidates to top-N; add the index only if a large `item` table proves slow). |
| **3.1 Markdown→Notion blocks** | **FIX** | Two-sided: Task 13 **constrains the synthesis prompt** to simple markdown (paragraphs + `-` bullets, no headers/code/tables; the synthesizer appends the Sources section itself), and Task 14's converter is a small line-walker — `-`→`bulleted_list_item`, blank→skip, **any other line→`paragraph` (fallback, never throws)**; Confluence builds the same shape as `<ul><li>`/`<p>`. Added a converter test feeding a stray header/code line. *Chose constrain-output + robust-fallback over a full markdown lexer (YAGNI) — we control the synthesis prompt.* |
| **4.1 D19 audit scope** | **FIX (verified)** | Verified `iterateSourceFiles` (`scripts/structure-audit/lib.ts`) globs **both** `packages/*/src/**/*.ts` **and** `packages/mcp-connectors/*/src/**/*.ts` — the audit IS repo-wide. So Task 18's `TRIBAL_KB_WRITE_ALLOWED` now **definitively** includes the two connector `server.ts` paths (the tool-definition sites) alongside the gateway write-gate; the hedge was removed. Without them the connector defs would trip D19. |
