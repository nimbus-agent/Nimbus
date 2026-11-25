import type { GapNote } from "@nimbus-dev/sdk";

/**
 * The gaps of the pre-review brief (moved out of `prreview-build.ts` unchanged, in the same order): what the
 * checks are drawn from, the review lane a non-GitHub forge lacks, what the index could not supply, and what
 * the caps cut.
 */

const ALWAYS_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "These checks come from co-change in this repository's merged pull requests and from your own past reviews; the index holds no other reviewer's comments and no inline review comments.",
};
const OWNERS_GAP: GapNote = {
  category: "missing_relation_emit",
  detail:
    "Owners of the touched paths are not shown: the index does not link a pull request's paths to local files.",
  remediation: "run `nimbus owners <path>` in a local checkout",
};

/** The counts and facts the gaps are decided from (all already read by the build). */
export type PrereviewGapFacts = {
  readonly service: string;
  readonly coverage: { readonly truncated: number; readonly api_file_count: number } | null;
  readonly filesStored: number;
  readonly historyNoCoverage: number;
  readonly historyTruncated: number;
  readonly thin: number;
  readonly areasTotal: number;
  readonly areasChecked: number;
  readonly findingsRanked: number;
  readonly findingsShown: number;
  readonly hasSize: boolean;
  readonly minCohort: number;
};

export function prereviewGaps(f: PrereviewGapFacts): GapNote[] {
  return [ALWAYS_GAP, ...sourceGaps(f), ...capGaps(f), OWNERS_GAP];
}

/** What the forge and the index could not supply. */
function sourceGaps(f: PrereviewGapFacts): GapNote[] {
  const gaps: GapNote[] = [];
  if (f.service !== "github") {
    gaps.push({
      category: "missing_connector",
      detail: `No review data is indexed for ${f.service}: only your own GitHub reviews are indexed, so the review lane and the size comparison are empty.`,
    });
  }
  if (f.service === "bitbucket") {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "Bitbucket records no merge time, so the history window uses each pull request's last update time instead.",
    });
  }
  if (f.coverage === null) {
    gaps.push({
      category: "missing_entity_type",
      detail:
        "This pull request's changed files are not in the index, so no area-based check could run.",
      remediation: `run \`nimbus connector sync ${f.service}\``,
    });
  } else if (f.coverage.truncated !== 0) {
    gaps.push({
      category: "missing_entity_type",
      detail: `This pull request's file list is incomplete in the index (${String(f.filesStored)} of ${String(f.coverage.api_file_count)} files stored), so no co-change check is shown: a missing file might be among the unstored ones.`,
    });
  }
  if (f.historyNoCoverage > 0 || f.historyTruncated > 0) {
    gaps.push({
      category: "missing_entity_type",
      detail: `${String(f.historyNoCoverage)} merged pull request(s) with no indexed file list and ${String(f.historyTruncated)} with an incomplete one were left out of the history.`,
    });
  }
  return gaps;
}

/** What thin history and the caps left unjudged or unshown. */
function capGaps(f: PrereviewGapFacts): GapNote[] {
  const gaps: GapNote[] = [];
  if (f.thin > 0) {
    gaps.push({
      category: "empty_index",
      detail: `${String(f.thin)} area(s) had fewer than ${String(f.minCohort)} comparable merged pull requests and were not judged.`,
    });
  }
  if (f.areasTotal > f.areasChecked) {
    gaps.push({
      category: "empty_index",
      detail: `Only the ${String(f.areasChecked)} largest of ${String(f.areasTotal)} touched areas were checked.`,
    });
  }
  if (f.findingsRanked > f.findingsShown) {
    gaps.push({
      category: "empty_index",
      detail: `${String(f.findingsRanked - f.findingsShown)} further co-change finding(s) are not shown.`,
    });
  }
  if (f.service === "github" && !f.hasSize) {
    gaps.push({
      category: "missing_entity_type",
      detail: `No size comparison: it needs this pull request's line counts and at least ${String(f.minCohort)} comparable merged pull requests with theirs.`,
    });
  }
  return gaps;
}
