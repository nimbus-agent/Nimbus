# Review: Nimbus MCP Server Implementation Plan

**Date:** 2026-06-02
**Context:** Review of `docs/superpowers/plans/2026-06-02-nimbus-mcp-server.md`

## Overview

The implementation plan successfully addresses several potential issues from the initial design spec, notably by introducing a persistent/reconnecting IPC client rather than lazy per-call connection, and by clamping results to 50 items with a strict `META_WHITELIST` to protect the editor LLM's context window.

## Open Questions & Suggestions

1. **`projectRankedItem` Missing `description` Field**
   - *Observation:* The projection explicitly preserves `name`, `service`, `type`, `url`, `score`, `modifiedAt`, `semanticSnippet`, and `meta`. It appears to drop `description` or `summary` if those exist on the top level of the ranked item.
   - *Suggestion:* If connectors provide a `description` (e.g., PR body snippet, incident summary) that is not part of `semanticSnippet`, dropping it might deprive the LLM of critical context. Consider whether a `description` or `summary` field should be preserved in `projectRankedItem`.

2. **`META_WHITELIST` Extensibility & Coverage**
   - *Observation:* `META_WHITELIST` is hardcoded to `["state", "number", "author", "status", "severity"]`.
   - *Question/Suggestion:* While this prevents leaking huge blobs or vault credentials, different item types might have other highly relevant, safe metadata fields (e.g., `priority` for incidents, `labels` for PRs). It might be worth periodically reviewing if this whitelist is too restrictive, or making it a per-item-type whitelist in the future.

3. **`getDoraMetrics` Required Parameter Handling**
   - *Observation:* The `schema` for `getDoraMetrics` defines `service` as a required string (`service: z.string()`), but the `run` implementation uses `optString(args, "service") ?? ""` as a fallback.
   - *Suggestion:* Since the MCP SDK will validate against the Zod schema before invoking the `run` method, `service` is guaranteed to be a string. The fallback `?? ""` is safe but redundant. This is a minor nitpick, no blocking change needed.

4. **Programmatic `stdout` Hygiene Test**
   - *Observation:* The plan relies on a manual check (Task 6, Step 4) to ensure no banners or extra logs pollute `stdout` when running `--stdio`.
   - *Suggestion:* Given how critical `stdout` is for the MCP transport, it might be beneficial to add an automated integration or CLI test that spawns the CLI process with `--stdio` and pipes a minimal JSON-RPC request to `stdin`, asserting that `stdout` parses strictly as valid JSON-RPC lines without any extra text.
