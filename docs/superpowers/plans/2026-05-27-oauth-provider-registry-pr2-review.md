# Review: Zoom Connector (PR-2) Implementation Plan

The plan for adding the Zoom connector is thorough and adheres closely to the established patterns from PR-1 (OAuth registry, auth handler logic, lazy mesh). Below are some questions, suggestions, and improvements for consideration before or during implementation.

## 1. Mapper (`zoom-meeting-mapping.ts`)
* **`modifiedAt` Fallback Logic:** The mapper sets `modifiedAt: startMs ?? createdMs ?? ctx.syncedAt`. It uses the scheduled start time (`startMs`) as the primary modification timestamp. If the meeting is scheduled in the future, this will result in a future-dated `modifiedAt` in the index. If the Zoom API provides an `updated_at` field, it might be more accurate to prioritize `updated_at` over `start_time`.
* **Topic Fallback:** Setting `title` to `Meeting ${externalId}` when the topic is missing is robust. Just ensure that `externalId` is strictly the parsed meeting ID.

## 2. Sync Handler (`zoom-sync.ts`)
* **Pagination limit:** `MAX_PAGES = 20` with `PAGE_SIZE = 100` limits the sync to 2,000 scheduled meetings. This is a reasonable upper bound for standard users, but for heavy Zoom users with years of recurring meetings, this might truncate their history. If 2,000 is the intended cap for Phase 5, this is perfectly fine, but worth noting for future iterations.
* **Rate Limiting:** `ctx.rateLimiter.acquire(SERVICE_ID)` is called correctly per page. Ensure that the centralized rate limit configuration (`CONNECTOR_RATE_LIMITS`) has an appropriate request-per-second limit configured for `zoom` to prevent 429 responses during deep pagination.

## 3. MCP Server (`packages/mcp-connectors/zoom`)
* **`zoom_search` Pagination Limitation:** The `zoom_search` tool fetches only the first page (up to 100 meetings) and does a local substring search. While explicitly documented as "first page only", this could be confusing for users if they search for an older meeting that isn't in the most recent 100. Since Zoom doesn't have a native text search endpoint for meetings, this limitation makes sense for PR-2, but it might be worth mentioning in the tool description.
* **Meeting UUID Double Encoding:** The `zoom_get` tool uses `encodeURIComponent(p.id)`. The Zoom API documentation specifies that if a meeting UUID is used instead of a numeric ID, and the UUID begins with a `/` character or contains `//`, you must **double-encode** the meeting UUID before passing it in the path.

## 4. Auth & Vault
* **Secret Logging:** The explicit test ensuring that the client secret is never included in a thrown error is excellent and aligns perfectly with the security invariants (I3/I12).

## Conclusion
Overall, the plan is structurally sound and ready for execution. The tasks are well-sequenced, dependencies between files are mapped out, and the constraints of the Nimbus invariant system (like `I15` and `D11`) are appropriately handled.
