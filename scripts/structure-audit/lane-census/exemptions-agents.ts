// The `agents/` exemptions of the index lane-coverage gate, split out of `exemptions.ts` (file size);
// `exemptions.ts` spreads them into `LANE_EXEMPTIONS` in place, so the rules there apply unchanged.
import type { LaneExemption } from "./exemption-types.ts";

export const AGENTS_LANE_EXEMPTIONS: readonly LaneExemption[] = [
  {
    file: "packages/gateway/src/agents/_lib/cost-why-query.ts",
    key: "merge_commit_sha",
    category: "disclosed",
    reads: 1,
    reason:
      "Only the GitHub connector writes merge_commit_sha, so selectPr joins no pull request on GitLab/Bitbucket; contextFor adds the gap 'service <id>: a deploy is matched to its pull request by merge commit, which only the GitHub connector records' for any service with a non-GitHub repo.",
  },
  {
    file: "packages/gateway/src/agents/_lib/cost-why-query.ts",
    key: "user",
    category: "by-design",
    reads: 1,
    reason:
      "selectPr reads the author from the person row joined by item.author_id first; metadata.user (GitHub only) is a fallback, and a pull request with neither prints no author rather than a guessed one.",
  },
  {
    file: "packages/gateway/src/agents/_lib/cost-why-query.ts",
    key: "run_id",
    category: "census-blind",
    reads: 1,
    reason:
      "annotateDeployment in deployment/annotate.ts writes the deployment item's metadata (run_id among it) as an inline JSON.stringify object inside a db.transaction, a shape the writer scan does not trace; selectDeploys reads it only after deployment_items.ci_run_external_id, and a deploy with neither shows no run id.",
  },
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
    file: "packages/gateway/src/agents/_lib/negotiate/lanes-prs.ts",
    key: "additions",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; accumulateAuthoredPrStats tallies statsCoverage and agents/_lib/render/negotiate.ts renderNegotiateAuthoredPrs prints '(stats coverage N/M)' or 'stats: not available (no enriched PR in this window)'.",
  },
  {
    file: "packages/gateway/src/agents/_lib/negotiate/lanes-prs.ts",
    key: "deletions",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render/negotiate.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
  },
  {
    file: "packages/gateway/src/agents/_lib/negotiate/lanes-prs.ts",
    key: "changed_files",
    category: "disclosed",
    reads: 1,
    reason:
      "PR size stats are written by GitHub alone; read only on rows counted in statsCoverage, which agents/_lib/render/negotiate.ts renderNegotiateAuthoredPrs prints as '(stats coverage N/M)'.",
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
];
