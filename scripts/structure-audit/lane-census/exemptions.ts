/**
 * Exemptions for the index lane-coverage gate (`--check`). Matched on `(file, key)` — `file` the
 * repo-relative path, no line number (lines churn). An exemption that suppresses no current
 * violation is itself a violation (stale), so a fixed read cannot leave its exemption behind.
 */
export type LaneExemptionCategory = "disclosed" | "legacy" | "not-item" | "by-design";

export type LaneExemption = {
  /** Repo-relative, e.g. "packages/gateway/src/metrics/dora.ts". */
  readonly file: string;
  /** Metadata key (or item type, for a `kind: "type"` read). */
  readonly key: string;
  readonly category: LaneExemptionCategory;
  readonly reason: string;
};

export const LANE_EXEMPTIONS: readonly LaneExemption[] = [
  // ── agents/ ──────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/agents/_lib/oncall-queries.ts",
    key: "merge_commit_sha",
    category: "disclosed",
    reason:
      "Only the GitHub connector writes merge_commit_sha, so selectChangeForDeployment is empty on GitLab/Bitbucket; agents/oncall.ts runtimeGaps discloses it as a missing_connector gap ('A deployment is matched to its change by merge commit, which only the GitHub connector records').",
  },
  {
    file: "packages/gateway/src/agents/changelog-queries.ts",
    key: "merged_at",
    category: "disclosed",
    reason:
      "nonGithubMergedPrCount reads merged_at IS NULL precisely to count merged non-GitHub PRs that carry no merge time; agents/changelog.ts buildChangelogBrief renders that count as a missing_connector gap ('merged pull request(s) on a non-GitHub forge carry no merge time and so are not listed').",
  },
  {
    file: "packages/gateway/src/agents/standup-queries.ts",
    key: "merged_at",
    category: "disclosed",
    reason:
      "nonGithubMergedPrCount reads merged_at IS NULL precisely to count merged non-GitHub PRs that carry no merge time; agents/standup.ts buildStandupBrief renders that count as a missing_connector gap ('merged pull request(s) of yours on a non-GitHub forge carry no merge time and so are not listed under merged').",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "additions",
    category: "disclosed",
    reason:
      "PR size stats are written by GitHub alone; accumulateAuthoredPrStats tallies statsCoverage and agents/_lib/render.ts renderNegotiateAuthoredPrs prints '(stats coverage N/M)' or 'stats: not available (no enriched PR in this window)'.",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "deletions",
    category: "disclosed",
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
  },
  {
    file: "packages/gateway/src/agents/negotiate.ts",
    key: "changed_files",
    category: "disclosed",
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
  },
  {
    file: "packages/gateway/src/agents/premortem.ts",
    key: "merged_at",
    category: "disclosed",
    reason:
      "Bitbucket never records a merge time (and GitLab only inside the synced window), so such PRs drop out of the review-drag medians; premortem/risks.ts computeReviewDrag appends leftOutSentence ('Pull requests without both timestamps are left out of both medians.' plus the per-forge reason from forgeTimingReasons).",
  },
  {
    file: "packages/gateway/src/agents/why.ts",
    key: "number",
    category: "by-design",
    reason:
      "resolveItemArm reads number for ANY URL-resolved item type into WhyItemSubject.number, a nullable display field the published SDK type documents as 'Null when the indexed item carried no number — an incident usually has none'. The PR reads in this file (prResolvingItem, findPrForSha) are annotated scope=pr and covered by the canonical PR contract.",
  },
  // ── metrics/ ─────────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "project",
    category: "by-design",
    reason:
      "repoLikeMatchesUrn's GitLab arm is project OR repo: GitLab ci_run rows carry the raw project key, GitLab pr rows carry only the canonical repo key, which the second operand matches.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "head_sha",
    category: "disclosed",
    reason:
      "Jenkins writes no head_sha, so ciRunHeadSha returns null and no PR merge commit can match that deploy; prLeadTime then marks the PR approximate and leadTimeGap reports approximate_lead_time.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "headSha",
    category: "legacy",
    reason: "raw pre-A1 key, read only when `meta_v` is absent (`ciRunHeadSha`)",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "labels",
    category: "disclosed",
    reason:
      "Only GitHub writes a labels array; when excludePrLabels is set and a PR carries none, prLeadTime sets labelsUnknown and leadTimeGap reports pr_labels_unavailable.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "merged_at",
    category: "disclosed",
    reason:
      "Bitbucket never records a merge time (GitLab only inside the synced window); prLeadTime sets mergeTimeUnknown for a merged PR without one and leadTimeGap reports incomplete_merge_data.",
  },
  {
    file: "packages/gateway/src/metrics/dora.ts",
    key: "merge_commit_sha",
    category: "disclosed",
    reason:
      "Only GitHub writes merge_commit_sha; prLeadTime marks a merged PR without one approximate and leadTimeGap reports approximate_lead_time.",
  },
  {
    file: "packages/gateway/src/metrics/service-identity.ts",
    key: "repo",
    category: "by-design",
    reason:
      "Prefect deployment definitions never carry a repo, so repoMetadataMatchesUrn never binds them by repo; buildServiceIdentityResolver tries nimbus_service_id and pagerduty_service_id first and returns unknown otherwise, which the graph populator resolves from metadata.service.",
  },
  // ── preflight/ ───────────────────────────────────────────────────────────────────────────
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "repo",
    category: "by-design",
    reason:
      "selectFailingCiRuns uses repo only as a PARTITION key of its latest-run window, COALESCEd to '' so a provider that writes none (Jenkins) still partitions per service; repo scoping itself is done afterwards by repoLikeMatchesUrn.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "workflow_name",
    category: "by-design",
    reason:
      "selectFailingCiRuns uses workflow_name only as a PARTITION key of its latest-run window, COALESCEd to '' so a provider that writes none (CircleCI, GitLab) partitions per repo instead.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "branch",
    category: "disclosed",
    reason:
      "Jenkins writes no branch, so selectFailingCiRuns cannot judge its runs; it reports ci_not_evaluable via unevaluableCiServices(…, 'preflight_failing_runs') (metrics/ci-evaluability.ts), derived from the ci_run contract table.",
  },
  {
    file: "packages/gateway/src/preflight/preflight.ts",
    key: "mergeable_state",
    category: "disclosed",
    reason:
      "Only GitHub writes mergeable_state; selectMergeConflicts counts open PRs whose mergeable_state IS NULL and reports the unknown_mergeable_state gap.",
  },
];
