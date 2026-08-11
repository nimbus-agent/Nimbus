# GitHub connector — quirks

Migrated from inline comments in `packages/gateway/src/connectors/github-*.ts` and `packages/mcp-connectors/github/`.

## Entries

### `mergeable_state` refresh policy: events-driven sync does not cover stale PRs

**Source:** `packages/gateway/src/connectors/github-sync.ts:65` — added 2026-05-28
**Original comment (excerpt):** `NOTE: The github sync is currently events-driven (/users/{login}/events), not a list-pass over /repos/{owner}/{repo}/pulls. PullRequestEvent payloads populate mergeable_state whenever a PR is touched, but stale open PRs that haven't had activity in the events feed do not refresh. Driving this policy from a periodic refresh pass is deferred; the preflight calculator handles missing state via its unknown_mergeable_state gap branch.`

The GitHub sync handler fetches `PullRequestEvent` entries from the `/users/{login}/events` feed rather than paginating over all open PRs in each repo. This means `mergeable_state` is refreshed only when a PR receives activity in the events feed; long-lived PRs with no recent activity remain stale. `shouldRefreshMergeableState` applies a 24-hour thrash guard and a 7-day activity window to decide whether to issue a detail-endpoint call for a given PR. The preflight calculator gracefully handles missing `mergeable_state` values via an `unknown_mergeable_state` gap in the verdict — it does not assume a stale null means the PR is conflict-free.

### Pull-request reviews

Reviews you leave on pull requests are indexed as their own items and linked to the
pull request in the relationship graph, so `nimbus expert` and `nimbus why` can
attribute review work.

Three limits are worth knowing:

- **Reviewing a pull request indexes that pull request**, including ones you did not
  author. This is what lets a review link to a titled PR rather than a bare id.
- This indexes **pull requests you reviewed**, not **who reviewed your pull
  requests** — the GitHub events feed reports your own activity.
- Coverage begins when the connector first syncs. The events feed exposes only a
  recent window, so reviews from before then are not recoverable by syncing. A review
  deleted upstream also leaves its graph link in place.
