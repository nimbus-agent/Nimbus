# Targeted Fetch Miss Reason & Credential Validation — Design Review & Feedback

> **HISTORICAL — do not read as current contract.** A point-in-time review of
> the design, kept for provenance; its open questions were answered during
> implementation. The health-state question in particular is settled: a
> successful probe clears a stuck `unauthenticated` state and the scheduled sync
> path resumes. The shipped contract lives in
> `packages/gateway/src/connectors/health.ts` (the `reauthenticated` event),
> `packages/gateway/src/index/local-index.ts`
> (`markConnectorReauthenticated`, which fires only from `unauthenticated`), and
> `packages/gateway/test/integration/connector-auth-unsticks-scheduler.test.ts`
> (which proves the scheduler actually dispatches again). The code is
> authoritative.

## Open Questions

1. **OAuth Scopes verification vs. PATs:**
   - The design mentions that a GitHub fine-grained PAT might return a 403 on `/user` but still work perfectly for other operations, which is why 403 is treated as `stored, reported unverified`.
   - *Question:* For connectors that support OAuth or multiple scopes, can the probe check scopes metadata (e.g., the `X-OAuth-Scopes` header returned in the GitHub API response)? This would allow reporting a more precise warning if required scopes are missing, rather than a generic `unverified`.

2. **Retry/Backoff and Rate Limiting on Probes:**
   - During `connector auth`, since a probe is an outbound call, what happens if the network request is rate-limited by the provider (e.g., 429)?
   - *Question:* Should the `CREDENTIAL_PROBES` reuse the unified HTTP client with rate-limiting/backoff (`science-skills-common` or gateway equivalent)? Or should it fail fast to avoid blocking the CLI/UI tool?

3. **Database Health States Syncing:**
   - The design mentions that GitLab/Jenkins/Bitbucket don't throw `UnauthenticatedError` during syncs, which is out of scope.
   - *Question:* When the new `connector auth` probe succeeds, does it immediately transition the syncable's reactive `healthState` in the database to `healthy`? (For instance, if it was previously marked `unauthenticated` due to an expired token, and the user runs `nimbus connector auth github` with a fresh token). If we don't update it, the connector might remain stuck in `"unauthenticated"` due to `SKIP_HEALTH_STATES`.

## Suggestions & Improvements

1. **Leveraging the unified mapper in mock servers/E2E tests:**
   - *Suggestion:* Make sure the mock servers used in E2E tests (`packages/gateway/test/e2e/mocks/`) are updated to return these explicit error reasons (e.g. `unauthorized`, `absent`, `unreachable`) for targeted fetch queries. This ensures that client integrations (CLI/Tauri UI) can be tested end-to-end under real credential-failure scenarios.

2. **CLI Exit Codes Clarification:**
   - *Suggestion:* For `connector auth` 401 failures, the design states the CLI exits non-zero (`exit 1`). We should explicitly define a consistent exit code convention if Nimbus distinguishes between network failures (e.g. exit 2) vs auth failures (e.g. exit 1).

3. **Verify DPAPI/Vault transaction safety:**
   - Since "probe before write" ensures we don't clobber a working stored credential, we should double check if the Vault operations (e.g. DPAPI write) can be wrapped in a transaction or backup mechanism. If validation succeeds but writing the new credential fails mid-way, the user might end up with no credentials. A simple verify-then-overwrite backup flow is recommended.
