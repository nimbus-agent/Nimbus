# Chromatic Connector Design Review

**Date:** 2026-06-04
**Target:** `2026-06-04-chromatic-connector-design.md`

## Open Questions & Suggestions

1. **GraphQL Schema Stability (Risk Mitigation)**
   As noted in the design, the GraphQL schema is not officially documented. 
   *Suggestion:* Consider adding robust structural validation (e.g., using defensive checks) when parsing the GraphQL responses in `chromaticGraphql()` or `mapChromaticBuildToItem`. This ensures that if Chromatic changes a field name (e.g., `committerName` to `committer`), the connector fails gracefully with a clear log message rather than throwing an unhandled `TypeError` during syncing.

2. **Rate Limiting & Pagination**
   The rate limit is set to 30 requests per minute (`requestsPerMinute: 30, burstSize: 10`).
   *Question:* For users with many active Chromatic projects, the initial sync (depth of 30 days) might require many paginated requests to fetch all builds. Is 30 RPM sufficient to complete the initial sync without stalling? 
   *Suggestion:* Verify that `connectorFetch` will properly handle 429 responses from Chromatic by backing off and retrying, or consider slightly increasing the RPM limit if Chromatic's actual undocumented limit allows it.

3. **`startedAt` Field Nullability**
   *Question:* Can a build in the `PENDING` status have a `null` or missing `startedAt` field in the GraphQL response?
   *Suggestion:* Ensure the defensive date parsing helper falls back to a safe default (like the current time or dropping the field) if `startedAt` is absent, to prevent mapping errors for queued builds.

4. **Network Allowlist**
   The manifest allows `index.chromatic.com`. 
   *Suggestion:* Double-check if the GraphQL endpoint ever issues redirects to other subdomains, or if Chromatic uses a different host for different tenants. `index.chromatic.com` is strictly correct for the GraphQL endpoint based on the spec, but worth confirming during implementation.

## Alignment with Invariants
- The decision to keep the CLAUDE.md / GEMINI.md status line unedited regarding App Center aligns perfectly with the project's rules.
- The use of `first-party-manifests.ts` and `connector-secrets-manifest.ts` correctly follows the Phase 5 extension and vault patterns.
