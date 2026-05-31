# Phase 5 Connector Buildout — Program Design Review

**Date:** 2026-05-24

This document captures open questions, suggestions, and potential improvements based on a review of the `2026-05-24-phase-5-connector-buildout-program-design.md` specification.

## Open Questions

1. **Tier 3 (No-row-data) Enforcement:**
   The design mentions that Tier 3 connectors will carry an extra contract test asserting no row-fetch / cell-read tools on the connector surface.
   * *Question:* Will this assertion purely be a static unit/integration test, or should this also be codified as a runtime Gateway invariant (e.g., a new security invariant like I17) that dynamically blocks row-fetching tools from these specific connectors?

2. **Tier 4 (Email) Attachments:**
   * *Question:* When reading emails via IMAP/JMAP, will attachments be indexed or surfaced to the LLM? If so, what are the sandbox/security implications of downloading and parsing arbitrary email attachments locally?

3. **Vault Scaling for OAuth (Tier 2):**
   * *Question:* Adding ~45 connectors means a significant increase in vault keys and potentially concurrent token refresh cycles. Does `oauth-vault-tokens.ts` need any structural changes or rate-limiting for refreshes to handle this volume without hitting DPAPI bottlenecks or API limits?

## Suggestions & Improvements

1. **PR Batching for Similar Connectors:**
   * *Suggestion:* The document specifies "One PR per connector". Given the volume (~45 connectors), this might lead to review fatigue. Consider amending the cadence to: *One PR per connector for the first of its kind, then optionally batching highly similar subsequent connectors (e.g., grouping Vercel and Netlify).*

2. **Testing Template Expansion:**
   * *Suggestion:* Under "Per-connector template", add a requirement for testing error/rate-limit handling specifically. Since Phase 5 expands heavily into third-party APIs (Tier 1 & 2), ensuring that standard `http-client` exponential backoffs and `429 Too Many Requests` are tested for each connector will prevent flaky integrations.

3. **Tier 5 (Local) Discovery:**
   * *Suggestion:* For local DB schema indexing, clarify if the connector will need to execute local binaries (e.g., `sqlite3`, `psql`) or if it will use pure TypeScript drivers. If executing binaries, it should be explicitly noted how this interacts with the `sandbox-wrapper` invariants.
