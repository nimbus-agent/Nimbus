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
export type LaneExemptionCategory = "disclosed" | "legacy" | "not-item" | "by-design";

export type LaneExemption = {
  /** Repo-relative, e.g. "packages/gateway/src/metrics/dora.ts". */
  readonly file: string;
  /** Metadata key (or item type, for a `kind: "type"` read). */
  readonly key: string;
  readonly category: LaneExemptionCategory;
  /** The exact number of violations this exemption suppresses — see the module comment. */
  readonly reads: number;
  readonly reason: string;
};

export const LANE_EXEMPTIONS: readonly LaneExemption[] = [
  // ── agents/ ──────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/agents/_lib/oncall-queries.ts",
    key: "merge_commit_sha",
    category: "disclosed",
    reads: 1,
    reason:
      "Only the GitHub connector writes merge_commit_sha, so selectChangeForDeployment is empty on GitLab/Bitbucket; agents/oncall.ts runtimeGaps discloses it as a missing_connector gap ('A deployment is matched to its change by merge commit, which only the GitHub connector records').",
  },
  {
    file: "packages/gateway/src/agents/changelog-queries.ts",
    key: "merged_at",
    category: "disclosed",
    reads: 1,
    reason:
      "nonGithubMergedPrCount reads merged_at IS NULL precisely to count merged non-GitHub PRs that carry no merge time; agents/changelog.ts buildChangelogBrief renders that count as a missing_connector gap ('merged pull request(s) on a non-GitHub forge carry no merge time and so are not listed').",
  },
  {
    file: "packages/gateway/src/agents/standup-queries.ts",
    key: "merged_at",
    category: "disclosed",
    reads: 1,
    reason:
      "nonGithubMergedPrCount reads merged_at IS NULL precisely to count merged non-GitHub PRs that carry no merge time; agents/standup.ts buildStandupBrief renders that count as a missing_connector gap ('merged pull request(s) of yours on a non-GitHub forge carry no merge time and so are not listed under merged').",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "additions",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; accumulateAuthoredPrStats tallies statsCoverage and agents/_lib/render.ts renderNegotiateAuthoredPrs prints '(stats coverage N/M)' or 'stats: not available (no enriched PR in this window)'.",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "deletions",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "changed_files",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
  },
  {
    file: "packages/gateway/src/agents/premortem.ts",
    key: "merged_at",
    category: "disclosed",
    reads: 5,
    reason:
      "Bitbucket never records a merge time (and GitLab only inside the synced window), so such PRs drop out of the review-drag medians; agents/premortem.ts repoForgesMissingTiming adds the forges of such merged BASELINE PRs, and premortem/risks.ts computeReviewDrag appends leftOutSentence ('Pull requests without both timestamps are left out of both medians.' plus the per-forge reason from forgeTimingReasons).",
  },
  {
    file: "packages/gateway/src/agents/why.ts",
    key: "number",
    category: "by-design",
    reads: 1,
    reason:
      "resolveItemArm reads number for ANY URL-resolved item type into WhyItemSubject.number, a nullable display field the published SDK type documents as 'Null when the indexed item carried no number — an incident usually has none'. The PR reads in this file (prResolvingItem, findPrForSha) are annotated scope=pr and covered by the canonical PR contract.",
  },
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
  // ── graph/ ───────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/graph/graph-populator.ts",
    key: "number",
    category: "by-design",
    reads: 1,
    reason:
      "findIssueEntityIds matches an issue by metadata number+repo only as a FALLBACK after the exact external-id lookup (findIssueByIndexedExternalId) misses. GitHub and GitLab issue rows both carry number and repo, but the GitLab writer takes its type from GitlabItemShape, which the census cannot see, so the read stays unscoped. A miss links no issue, never a wrong one.",
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
    category: "by-design",
    reads: 1,
    reason:
      "selectItemBodyFetchState (annotated scope=page service=notion) reads the bodyFetch verdict connectors/notion-sync.ts writes into a metadata variable built by a ternary before ctx.upsertItem — a shape the census writer scan does not follow (it records the notion:page write with no keys). Absent by design means never attempted or errored, which marks the page retryable.",
  },
  // ── ipc/ ─────────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/ipc/clip-rpc.ts",
    key: "sourceWordCount",
    category: "by-design",
    reads: 3,
    reason:
      "rowToClipEntry (annotated scope=web_clip) reads sourceWordCount, which clips/clip-ingest.ts ingestClip writes only for an over-cap clip, inside a conditional spread the census writer scan does not follow. Absent by design means not truncated (also the reading of a clip ingested before the field existed).",
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
];
