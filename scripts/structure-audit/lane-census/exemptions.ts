/**
 * Exemptions for the index lane-coverage gate (`--check`). Matched on `(file, key)` — `file` the
 * repo-relative path, no line number (lines churn). An exemption that suppresses no current
 * violation is itself a violation (stale), so a fixed read cannot leave its exemption behind.
 *
 * `reads` is REQUIRED and must equal the exact number of violations the exemption suppresses
 * (ruling amending R6). A (file, key) match alone would also silence a FUTURE dead read of the same
 * key in the same file; with the count pinned, a read added or removed under an existing exemption
 * fails as `exemption-count` until someone reviews it and updates `reads` (or the reason).
 */

import type { LaneExemption } from "./exemption-types.ts";
import { AGENTS_LANE_EXEMPTIONS } from "./exemptions-agents.ts";

export type { LaneExemption, LaneExemptionCategory } from "./exemption-types.ts";

export const LANE_EXEMPTIONS: readonly LaneExemption[] = [
  // ── prreview/ ────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/prreview/prreview-build.ts",
    key: "merged_at",
    category: "disclosed",
    reads: 3,
    reason:
      "loadHistory orders and windows merged PRs by COALESCE(merged_at, item.modified_at), so a Bitbucket PR (no merge time) falls back to the last update (the GitLab connector writes merged_at from the MR resource for a merged MR, so GitLab rows normally have it); buildPrereviewBrief adds the gap 'Bitbucket records no merge time, so the history window uses each pull request's last update time instead'.",
  },
  {
    file: "packages/gateway/src/prreview/prreview-build.ts",
    key: "additions",
    category: "disclosed",
    reads: 1,
    reason:
      "Only GitHub writes PR line counts; for any other forge the size lane is empty and buildPrereviewBrief's 'No review data is indexed for <service>' gap says the review lane and the size comparison are empty.",
  },
  {
    file: "packages/gateway/src/prreview/prreview-build.ts",
    key: "deletions",
    category: "disclosed",
    reads: 1,
    reason:
      "Only GitHub writes PR line counts; for any other forge the size lane is empty and buildPrereviewBrief's 'No review data is indexed for <service>' gap says the review lane and the size comparison are empty.",
  },
  // ── agents/ ──────────────────────────────────────────────────────────────────────────────
  ...AGENTS_LANE_EXEMPTIONS,
  // ── connectors/ ──────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/connectors/great-expectations-sync.ts",
    key: "run_id",
    category: "not-item",
    reads: 2,
    reason:
      "deriveRunId/deriveRunTime read run_id from the meta object of a Great Expectations validation-result FILE (buildMappingContext: asRecord(parsed['meta']) of the JSON read off results_dir), a function parameter the census cannot trace — never an item row.",
  },
  {
    file: "packages/gateway/src/connectors/great-expectations-sync.ts",
    key: "active_batch_definition",
    category: "not-item",
    reads: 1,
    reason:
      "deriveBatchId reads active_batch_definition from the meta object of a Great Expectations validation-result FILE (buildMappingContext), a function parameter — never an item row.",
  },
  {
    file: "packages/gateway/src/connectors/great-expectations-sync.ts",
    key: "batch_spec",
    category: "not-item",
    reads: 1,
    reason:
      "deriveBatchId reads batch_spec from the meta object of a Great Expectations validation-result FILE (buildMappingContext), a function parameter — never an item row.",
  },
  {
    file: "packages/gateway/src/connectors/_lib/gitlab/events.ts",
    key: "author_login",
    category: "by-design",
    reads: 1,
    reason:
      "itemAuthor reads the metadata gitlabMrMetadata just built for the SAME upsert (upsertGitlabEventItem), where withAuthor adds author_login whenever the MR author is known — from this event (an opened event or fetchOne) or carried forward from the stored row. Absent means no author is known yet, and the row is credited to no one rather than to the event actor.",
  },
  {
    file: "packages/gateway/src/connectors/_lib/gitlab/events.ts",
    key: "author_name",
    category: "by-design",
    reads: 1,
    reason:
      "itemAuthor reads the metadata gitlabMrMetadata just built for the SAME upsert, where withAuthor adds author_name alongside author_login.",
  },
  // ── glossary/ ────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/glossary/glossary-visibility.ts",
    key: "glossary_term_local",
    category: "census-blind",
    reads: 1,
    reason:
      "antiJoinSuffices checks whether any nimbus:glossary_term_local item exists; syncTermProjection in glossary/glossary-visibility.ts writes it through projectTerm in glossary/glossary-project.ts, whose upsertIndexedItem call takes the type from a parameter (and glossary/ is outside WRITER_INCLUDE). Absent means no term routes locally, so the fast-path sweep may skip re-routing.",
  },
  // ── graph/ ───────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/graph/graph-populator.ts",
    key: "number",
    category: "by-design",
    reads: 1,
    reason:
      "findIssueEntityIds matches an issue by metadata number+repo only as a FALLBACK after the exact external-id lookup (findIssueByIndexedExternalId) misses. The fallback query's only type predicate is on the graph_entity alias (e.type = 'issue'), so the item metadata read is unscoped regardless of writer visibility; GitHub and GitLab issue rows both carry number and repo (the GitLab writer takes its type from GitlabItemShape, which the census cannot see either). A miss links no issue, never a wrong one.",
  },
  {
    file: "packages/gateway/src/graph/graph-populator.ts",
    key: "repo",
    category: "by-design",
    reads: 1,
    reason:
      "The repo half of the findIssueEntityIds number+repo fallback match (see the number exemption); a miss links no issue, never a wrong one.",
  },
  // ── index/ ───────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/index/item-store.ts",
    key: "bodyFetch",
    category: "census-blind",
    reads: 1,
    reason:
      "selectItemBodyFetchState (annotated scope=page service=notion) reads bodyFetch, which notionConsumeSearchResultRow in connectors/notion-sync.ts writes into a metadata variable initialised by a ternary before ctx.upsertItem — a shape the census writer scan does not follow (it records the notion:page write with no keys). Absent means never attempted or errored, which marks the page retryable.",
  },
  {
    file: "packages/gateway/src/index/resolve-by-url.ts",
    key: "branch",
    category: "by-design",
    reads: 1,
    reason:
      "resolveItemByUrl passes a row's branch through to the caller when it has one. Writers that record no branch (Jenkins, and a GitLab MR no fetchOne has reached) simply omit item.branch, and the browser client then says it could not check that page's own branch.",
  },
  // ── ipc/ ─────────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/ipc/clip-rpc.ts",
    key: "sourceWordCount",
    category: "census-blind",
    reads: 3,
    reason:
      "rowToClipEntry (annotated scope=web_clip) reads sourceWordCount, which ingestClip in clips/clip-ingest.ts writes (for an over-cap clip only) inside a conditional object spread the census writer scan does not follow. Absent means not truncated (also the reading of a clip ingested before the field existed).",
  },
  // ── multimodal/ ──────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/multimodal/media-discovery.ts",
    key: "path",
    category: "by-design",
    reads: 1,
    reason:
      "findCandidates reads path into MediaCandidate.sourcePath; only filesystem media rows carry a local path, and a null sourcePath on a Google Photos/Drive/OneDrive candidate is what routes it to the cloud byte-fetch (multimodal/cloud-bytes.ts).",
  },
  // ── metrics/ ─────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "project",
    category: "legacy",
    reads: 1,
    reason:
      "repoLikeMatchesUrn's GitLab arm reads project OR repo; project only matters for GitLab ci_run rows written before A1. Since A1, connectors/_lib/gitlab/pipelines.ts also writes repo with the same projectPath, so the repo operand already matches every current GitLab ci_run and pr row.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "head_sha",
    category: "disclosed",
    reads: 1,
    reason:
      "Jenkins writes no head_sha, so ciRunHeadSha returns null and no PR merge commit can match that deploy; prLeadTime then marks the PR approximate and leadTimeGap reports approximate_lead_time.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "headSha",
    category: "legacy",
    reads: 1,
    reason: "raw pre-A1 key, read only when `meta_v` is absent (`ciRunHeadSha`)",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "labels",
    category: "disclosed",
    reads: 2,
    reason:
      "Only GitHub writes a labels array; when excludePrLabels is set and a PR carries none, prLeadTime sets labelsUnknown and leadTimeGap reports pr_labels_unavailable.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "merged_at",
    category: "disclosed",
    reads: 1,
    reason:
      "Bitbucket never records a merge time (GitLab only inside the synced window); prLeadTime sets mergeTimeUnknown for a merged PR without one and leadTimeGap reports incomplete_merge_data.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "merge_commit_sha",
    category: "disclosed",
    reads: 1,
    reason:
      "Only GitHub writes merge_commit_sha; prLeadTime marks a merged PR without one approximate and leadTimeGap reports approximate_lead_time.",
  },
  {
    file: "packages/gateway/src/metrics/service-identity.ts",
    key: "repo",
    category: "by-design",
    reads: 2,
    reason:
      "Prefect deployment definitions and PagerDuty incidents never carry a repo, so repoMetadataMatchesUrn never binds them by repo: buildServiceIdentityResolver tries nimbus_service_id and pagerduty_service_id first (an incident binds on pagerduty_service_id) and otherwise returns unknown, which graph/graph-populator.ts resolveAffectedService resolves from metadata.service.",
  },
  // ── graph/ ───────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/graph/deployment-edges.ts",
    key: "sha",
    category: "census-blind",
    reads: 1,
    reason:
      "deployedSha reads the deployed sha of a CI-annotated deployment, which annotateDeployment in deployment/annotate.ts writes through a JSON.stringify of a metadata literal followed by a raw SQL INSERT (not a ctx.upsertItem or upsertIndexedItem call), a shape the census writer scan does not follow. Absent or malformed means no deployed edge.",
  },
  // ── preflight/ ───────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "repo",
    category: "by-design",
    reads: 1,
    reason:
      "selectFailingCiRuns uses repo only as a PARTITION key of its latest-run window, COALESCEd to '' so a provider that writes none (Jenkins) still partitions per service; repo scoping itself is done afterwards by repoLikeMatchesUrn.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "workflow_name",
    category: "by-design",
    reads: 1,
    reason:
      "selectFailingCiRuns uses workflow_name only as a PARTITION key of its latest-run window, COALESCEd to '' so a provider that writes none (CircleCI, GitLab) partitions per repo instead.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "branch",
    category: "disclosed",
    reads: 2,
    reason:
      "Jenkins writes no branch, so selectFailingCiRuns cannot judge its runs; it reports ci_not_evaluable via unevaluableCiServices(…, 'preflight_failing_runs') (metrics/ci-evaluability.ts), derived from the ci_run contract table.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "mergeable_state",
    category: "disclosed",
    reads: 4,
    reason:
      "Only GitHub writes mergeable_state; selectMergeConflicts counts open PRs whose mergeable_state IS NULL and reports the unknown_mergeable_state gap.",
  },
  {
    file: "packages/gateway/src/connectors/google-calendar-sync.ts",
    key: "start_ms",
    category: "census-blind",
    reads: 1,
    reason:
      "Reads the mapped row's own start_ms (not an SQL read) to drop an event outside the sync window. Its writer is normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts: the census writer scan does not follow a spread across files.",
  },
  {
    file: "packages/gateway/src/connectors/google-calendar-sync.ts",
    key: "end_ms",
    category: "census-blind",
    reads: 1,
    reason:
      "Reads the mapped row's own end_ms (not an SQL read) to drop an event outside the sync window. Its writer is normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts: the census writer scan does not follow a spread across files.",
  },
  {
    file: "packages/gateway/src/connectors/outlook-calendar-step.ts",
    key: "start_ms",
    category: "census-blind",
    reads: 1,
    reason:
      "Reads the mapped row's own start_ms (not an SQL read) to drop an event outside the sync window. Its writer is normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files.",
  },
  {
    file: "packages/gateway/src/connectors/outlook-calendar-step.ts",
    key: "end_ms",
    category: "census-blind",
    reads: 1,
    reason:
      "Reads the mapped row's own end_ms (not an SQL read) to drop an event outside the sync window. Its writer is normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "status",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write status through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "self_response",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write self_response through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "start_ms",
    category: "census-blind",
    reads: 3,
    reason:
      "Google Calendar and Outlook write start_ms through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "end_ms",
    category: "census-blind",
    reads: 3,
    reason:
      "Google Calendar and Outlook write end_ms through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "all_day",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write all_day through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "attendee_count",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write attendee_count through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. selectCalendarDay (the morning briefing) reads it from all three.",
  },
  {
    file: "packages/gateway/src/federation/_lib/free-busy-read.ts",
    key: "status",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write status through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. readBusyBlocks (federated free/busy, I17 (b)) reads it from all three.",
  },
  {
    file: "packages/gateway/src/federation/_lib/free-busy-read.ts",
    key: "self_response",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write self_response through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. readBusyBlocks (federated free/busy, I17 (b)) reads it from all three.",
  },
  {
    file: "packages/gateway/src/federation/_lib/free-busy-read.ts",
    key: "start_ms",
    category: "census-blind",
    reads: 2,
    reason:
      "Google Calendar and Outlook write start_ms through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. readBusyBlocks (federated free/busy, I17 (b)) reads it from all three.",
  },
  {
    file: "packages/gateway/src/federation/_lib/free-busy-read.ts",
    key: "end_ms",
    category: "census-blind",
    reads: 2,
    reason:
      "Google Calendar and Outlook write end_ms through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. readBusyBlocks (federated free/busy, I17 (b)) reads it from all three.",
  },
  {
    file: "packages/gateway/src/federation/_lib/free-busy-read.ts",
    key: "all_day",
    category: "census-blind",
    reads: 1,
    reason:
      "Google Calendar and Outlook write all_day through normalizedEventKeys in connectors/_lib/calendar-event-normalize.ts, called from google-calendar-event-mapping.ts and outlook-calendar-mapping.ts: the census writer scan does not follow a spread across files, so only iCloud's direct write is seen. readBusyBlocks (federated free/busy, I17 (b)) reads it from all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "repo",
    category: "by-design",
    reads: 1,
    reason:
      "selectReviews shows a CI state for an authored PR only when the newest ci_run carries BOTH repo and branch; a ci_run from a service that writes neither (Jenkins) simply cannot be matched, and the briefing says so ('n PRs have no branch recorded' covers the PR side).",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "branch",
    category: "by-design",
    reads: 1,
    reason:
      "selectReviews shows a CI state for an authored PR only when the newest ci_run carries BOTH repo and branch; a ci_run from a service that writes neither (Jenkins) simply cannot be matched. A PR row with no branch is counted and disclosed.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "due_at_ms",
    category: "census-blind",
    reads: 1,
    reason:
      "GitHub writes due_at_ms (a milestone due_on) through githubIssueDepthMetadata, spread into the issue metadata in github-sync.ts: the census writer scan does not follow that spread, so only Jira and Linear's direct writes are seen. ticketDueAt (the morning briefing) reads it for all three.",
  },
  {
    file: "packages/gateway/src/agents/_lib/briefing-queries.ts",
    key: "is_read",
    category: "census-blind",
    reads: 1,
    reason:
      "Outlook writes is_read inside a conditional spread (typeof m.isRead === 'boolean' ? { is_read, meta_v } : {}) in outlook-sync.ts upsertMessage, which the census writer scan does not see. selectUnreadMail counts rows without it as 'predate read tracking' and the briefing says so.",
  },
];
