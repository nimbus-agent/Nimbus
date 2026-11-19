import type {
  PrereviewBrief,
  PrereviewCoChange,
  PrereviewPrRef,
  PrereviewReviewNote,
} from "./prreview-types.ts";
import { hardenedPlain, hardenedTitleLink, type RenderOpts, renderGaps } from "./render.ts";

/**
 * The deterministic render of a `pr_prereview` brief (Phase 10 "Automated PR pre-review"). No model, no clock
 * (no generation time is printed, and every time is UTC), so two renders of the same index are byte-identical.
 * Every indexed string (a title, a path, review text, a term) goes through {@link hardenedTitleLink},
 * {@link hardenedPlain} or {@link codePath}; the fixed wording is ours.
 *
 * Wording: a co-change is a correlation in merged history ("In 7 of 9 merged pull requests ..."), never a
 * requirement. Reserved for I31: `## Gaps`.
 */

export const PREREVIEW_CO_CHANGE_HEADING = "## Usually changes with this";
export const PREREVIEW_REVIEWS_HEADING = "## Your past review notes on similar pull requests";
export const PREREVIEW_SIZE_HEADING = "## Size compared with history";

export const SNIPPET_MAX = 240;
const PATH_MAX = 160;

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A repo-relative path inside an inline-code span: line structure and backticks cannot survive. */
export function codePath(path: string): string {
  return `\`${hardenedPlain(path, PATH_MAX)}\``;
}

function areaLabel(area: string): string {
  return area === "." ? "the repository root" : `${codePath(`${area}/`)}`;
}

function prLink(p: PrereviewPrRef): string {
  return hardenedTitleLink(p.title, p.url);
}

function coChangeLine(c: PrereviewCoChange): string {
  const companion = codePath(c.companionKind === "directory" ? `${c.companion}/` : c.companion);
  const examples =
    c.examples.length === 0 ? "" : ` Examples: ${c.examples.map((e) => prLink(e)).join(", ")}.`;
  return `- In ${String(c.count)} of ${String(c.cohort)} merged pull requests that changed ${areaLabel(c.area)}, ${companion} also changed. This pull request does not change it.${examples}`;
}

function coChangeSection(brief: PrereviewBrief): string {
  let body: string;
  if (!brief.target.filesCovered) {
    body = "_Not available: this pull request's changed files are not in the index._";
  } else if (brief.coChanges.length === 0) {
    body = "_No co-change pattern met the threshold._";
  } else {
    body = brief.coChanges.map(coChangeLine).join("\n");
  }
  return [PREREVIEW_CO_CHANGE_HEADING, "", body].join("\n");
}

function reviewLine(n: PrereviewReviewNote): string {
  const state = n.state === "CHANGES_REQUESTED" ? "changes requested" : "commented";
  return `- ${prLink(n.pr)}, ${state} on ${utcDate(n.reviewedAtMs)}: "${hardenedPlain(n.body, SNIPPET_MAX)}"`;
}

function reviewsSection(brief: PrereviewBrief): string {
  if (brief.reviewNotes === null) {
    return [PREREVIEW_REVIEWS_HEADING, "", "_No review data is indexed for this service._"].join(
      "\n",
    );
  }
  if (brief.reviewNotes.length === 0) {
    return [PREREVIEW_REVIEWS_HEADING, "", "_No past review of yours matched._"].join("\n");
  }
  const lines = brief.reviewNotes.map(reviewLine);
  const shown = brief.reviewNotes.length;
  const matched = brief.counts.reviewsMatched;
  const more = matched > shown ? [`- _${String(matched - shown)} more not shown._`] : [];
  const terms =
    brief.reviewTerms.length === 0
      ? []
      : [
          "",
          `Words that recur in those reviews (a count, not a summary): ${brief.reviewTerms
            .map((t) => `${hardenedPlain(t.term, 32)} (${String(t.reviews)})`)
            .join(", ")}.`,
        ];
  return [PREREVIEW_REVIEWS_HEADING, "", ...lines, ...more, ...terms].join("\n");
}

function sizeSection(brief: PrereviewBrief): string {
  const s = brief.size;
  const body =
    s === null
      ? "_Not available._"
      : `- This pull request changes ${String(s.total)} lines. The median of ${String(s.comparable)} comparable merged pull requests is ${String(s.cohortMedian)}; this one is larger than ${String(s.percentile)}% of them.`;
  return [PREREVIEW_SIZE_HEADING, "", body].join("\n");
}

function headerOf(brief: PrereviewBrief): string {
  const t = brief.target;
  const ref = t.number === null ? hardenedPlain(t.repo) : `${hardenedPlain(t.repo)}#${String(t.number)}`;
  const files = t.filesCovered ? `${String(t.files.length)} file(s) changed` : "files not indexed";
  return [
    `# Pre-review: ${hardenedTitleLink(t.title, t.url)}`,
    "",
    `${ref} on ${hardenedPlain(t.service)}, ${files}. From ${String(brief.counts.historyUsed)} merged pull request(s) of the same repository.`,
  ].join("\n");
}

export function renderPrereview(brief: PrereviewBrief, opts?: RenderOpts): string {
  const gaps = opts?.omitReserved === true ? "" : renderGaps(brief.gaps).trim();
  return [headerOf(brief), coChangeSection(brief), reviewsSection(brief), sizeSection(brief), gaps]
    .filter((s) => s !== "")
    .join("\n\n");
}
