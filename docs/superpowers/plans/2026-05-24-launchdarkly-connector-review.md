# LaunchDarkly Connector Implementation Plan Review

**Date:** 2026-05-24

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-24-launchdarkly-connector.md` implementation plan.

## Open Questions

1. **Pagination Limits (MAX_PAGES_PER_PROJECT):**
   * *Question:* The plan hardcodes `MAX_PAGES_PER_PROJECT = 20` with `PAGE_SIZE = 100`, capping the maximum number of indexed flags per project at 2,000. For enterprise LaunchDarkly customers with massive deployments, 2,000 flags per project might be too low. Should this cap be increased, or made configurable via another vault key?

2. **Search Limits Consistency:**
   * *Question:* In `search-filter.ts`, the `cap` (limit) defaults to 50. In `server.ts`, the `launchdarkly_search` Zod schema allows `limit` up to 200, but the API fetch hardcodes `limit: "500"`. While this works to fetch a large haystack and then filter it down, could the discrepancy between the 50 default and the 200 max cause confusion if a user expects a larger result set without explicitly passing a limit?

## Suggestions & Improvements

1. **Handling Deleted Flags:**
   * *Suggestion:* The `launchdarkly-sync.ts` implementation is a single-pass cursor that upserts flags. It does not appear to handle the deletion of flags (e.g., removing a flag from the local index if it was deleted in LaunchDarkly). If a flag is deleted in LD, it might linger in the local index indefinitely. Consider if a "tombstone" or full-sync cleanup mechanism is needed, or if this is an accepted limitation of the single-pass model for Phase 5.

2. **Error Handling on `ldGet`:**
   * *Suggestion:* In `server.ts` (Task 6), `ldGet` throws a generic `Error` with the status code and up to 400 characters of the response body. Consider mapping specific status codes (like 401 Unauthorized, or 404 Not Found) to clearer user-facing error messages, specifically for `launchdarkly_get` which throws if the flag doesn't exist.

3. **Rate Limiting Resilience in `server.ts`:**
   * *Suggestion:* The gateway-side `Syncable` handles HTTP 429s gracefully (by returning `syncPassCursorHttpEmpty`), but the MCP server (`server.ts`) does not implement exponential backoff or 429 retries for live user queries. Adding a simple retry wrapper around `ldGet` in the MCP server could improve reliability during heavy concurrent agent activity.
