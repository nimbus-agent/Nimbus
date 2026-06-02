# Review: `nimbus mcp-server` Editor Context Design

**Date:** 2026-06-02
**Context:** Review of `2026-06-02-nimbus-mcp-server-editor-context-design.md`

## Open Questions & Suggestions

1. **Performance of Lazy IPC Connections**
   - *Design Statement:* "The IPC connection is established lazily per tool call (connect → call → disconnect in a `finally`)"
   - *Suggestion:* While statelessness is a great property, opening and closing the IPC socket on every single tool call could introduce unnecessary latency if the LLM chains multiple tool calls rapidly (e.g., searching for a deployment, then checking DORA metrics). Consider maintaining a persistent IPC connection for the lifetime of the `nimbus mcp-server --stdio` process, or implementing a keep-alive with automatic reconnection if the Gateway restarts.

2. **Large JSON Payload Size Limits**
   - *Design Statement:* "Results are returned as a single MCP text content item containing the JSON-stringified Gateway response."
   - *Suggestion:* Returning raw, un-truncated JSON for up to 500 items could easily exceed the context window limits of editor LLMs (like Claude Code or Cursor). It would be beneficial to add explicit safeguards, such as truncating large context chunks, omitting unnecessary metadata from the search results, or reducing the maximum allowed limit for the MCP tools to ensure the LLM can actually process the payload.

3. **`getOpenPRs` Post-Filtering Efficiency**
   - *Design Statement:* The tool post-filters `searchRanked` results to "open" PRs.
   - *Question/Suggestion:* If the tool fetches a limit of 20 recent PRs from the Gateway and post-filters them, and 18 of them are closed, the LLM will only receive 2 open PRs, which might seem incomplete. To guarantee a consistent number of open PRs, the tool might need to over-fetch from the Gateway under the hood, or the Gateway's `searchRanked` method could be extended to accept generic attribute filters (e.g., `state: open`) so the database handles the filtering.
