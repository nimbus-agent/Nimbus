# Security Scan v2 Design Review

**Date:** 2026-06-04
**Target:** `2026-06-04-security-scan-v2-design.md`

## Open Questions & Suggestions

1. **`git blame` Performance & Timeouts**
   *Question:* Even though the blame is bounded by `MAX_BLAME_LINES` (5000), running `git blame` on a file with a very deep commit history can be extremely slow. Does the `Bun.spawn` call need a timeout (or an `AbortSignal`) to ensure that a pathological file doesn't stall the filesystem sync process indefinitely?
   *Suggestion:* Add a generous timeout (e.g., 30-60 seconds) to the `Bun.spawn` blame call, catching the timeout exception to fall back to no blame (just as it catches detached HEAD or transient errors) rather than hanging the sync.

2. **Fingerprint Uniqueness (`match_redacted`)**
   *Question:* The fingerprint uses `match_redacted`. If `match_redacted` produces identical strings for secrets of the same length (e.g., replacing characters with `*`), two distinct secrets of the same length and pattern in the same file (`external_id`) will generate the *exact same fingerprint*. Muting one would inadvertently mute the other.
   *Suggestion:* Consider whether the fingerprint needs to include disambiguating context—such as the hash of the surrounding non-secret excerpt or a relative offset block—so that multiple secrets in the same file remain distinct while remaining resilient to shifting line numbers.

3. **Populating `excerptStartLine` for Existing Users**
   *Question:* The design correctly states that older items lacking `excerptStartLine` will gracefully return `blame: null`. Is there a UX path for existing users to populate this data?
   *Suggestion:* Document (or consider adding) a recommended command to force a filesystem resync (if `nimbus index re-embed` doesn't re-extract from disk) so users who want the blame attribution can easily trigger the metadata update.

4. **Streaming `iterateScannableItems`**
   *Question:* For workspaces with tens of thousands of items, loading all `body_preview` strings into memory simultaneously for `scanItemsForSecrets` might cause a large memory spike.
   *Suggestion:* Ensure `iterateScannableItems` uses SQLite streaming (e.g., `db.query().iterate()`) and processes the secrets in chunks (which aligns well with the progress emission every 200 items), keeping memory overhead low.

5. **`--fail-on-finding` and Extended Patterns**
   *Observation:* If a user runs `nimbus security scan --fail-on-finding --extended` in CI, the low-confidence false positives will break the build. This is standard behavior, but it places a heavy burden on the mute-list.
   *Suggestion:* This behavior is probably intended, but ensure the CLI documentation clearly warns users that `--extended` combined with `--fail-on-finding` requires a well-maintained `[security.allowlist]` to avoid flaky CI pipelines.

## Alignment with Invariants

- The isolation of `git` execution to `filesystem-v2-sync.ts` (keeping the scan itself read-only and fast) is a great architectural choice.
- Migration V32 and the `LongRunningJobRegistry` pattern correctly follow the established Phase 5 architectures.
- The use of `appendAuditEntry` for `security.scan_completed` continues to align with the audit logs without requiring new executor action types.
