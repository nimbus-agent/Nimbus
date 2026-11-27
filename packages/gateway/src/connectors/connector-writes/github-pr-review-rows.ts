// packages/gateway/src/connectors/connector-writes/github-pr-review-rows.ts
// The GitHub pull request review (`@nimbus-dev/connectors` 0.19.0): a Wave 2 write offered to the
// model behind a typed preview, a before-state read and a head-commit guard, kept out of
// `vcs-ci.ts`, whose size is locked by `audit:file-size`. Spread into the one row table by
// `index.ts`.
import {
  beforeReplyJson,
  excerptHead,
  presentFields,
  requiredStringAt,
  shownHead,
  stringAt,
} from "./before-select.ts";
import {
  type BeforeStateField,
  type BeforeStateGuard,
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";
import { githubPrReadArgs } from "./vcs-ci-readers.ts";

const SHA_40 = /^[0-9a-f]{40}$/i;

/**
 * GitHub `github_pr_get` (before-state) for a review: what `#N` is and the head commit the review
 * is pinned to. `Title` (required, so a reply without one reads `Before: unavailable`), `State`
 * and `Head commit`. Never the description (the rule of the comment rows).
 */
export function selectGithubPrReviewTarget(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shownHead(stringAt(j, ["state"]))],
      ["Head commit", shownHead(stringAt(j, ["head", "sha"]))],
    ]),
  ];
}

/**
 * The review's head binding, as `github_pr_merge`'s `sha` is bound (`GITHUB_MERGE_SHA_GUARD`): the
 * model must send `commitId`, and the pull request's head, read at call time, must be exactly that
 * commit. So the review the owner approves lands on the code the prompt names, never on a head
 * pushed in between (GitHub's `commit_id`). An absent, `null` or unreadable `commitId` or head
 * refuses. The comparison ignores case: the connector's schema takes either, and a hex sha names
 * the same commit in both.
 */
export const GITHUB_REVIEW_HEAD_GUARD: BeforeStateGuard = {
  reason:
    "the review must name the pull request's current head commit as commitId, and it is not that commit",
  appliesTo: () => true,
  allows: (reply, picked) => {
    const commitId = picked["commitId"];
    const head = stringAt(beforeReplyJson(reply), ["head", "sha"]);
    return (
      typeof commitId === "string" &&
      SHA_40.test(commitId) &&
      head !== undefined &&
      commitId.toLowerCase() === head.toLowerCase()
    );
  },
};

// The template names every key of the connector's schema, so the drift check offers it. APPROVE is
// not in the connector's `event` enum. The inline comments are shown in full as JSON (each path,
// line, side, startLine and body), and each body is scanned as the review body is
// (`nested-text-refusals.ts`). The reader is `github_pr_get` with exactly the repository and the
// number (`githubPrReadArgs`, the merge row's).
export const GITHUB_PR_REVIEW_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("github_pr_review_create", "github.pr.review.create", "mesh", 2), {
      target: "{owner}/{repo}#{pullNumber}",
      summary:
        "Submit a {event} review on GitHub pull request {owner}/{repo}#{pullNumber}; a submitted review cannot be deleted",
      fields: [
        textField(
          "event",
          "Event (COMMENT, or REQUEST_CHANGES: blocks merging under a required-review rule until dismissed)",
        ),
        textField("body", "Review"),
        textField(
          "comments",
          "Inline comments on the diff (path, line, side, startLine, body)",
          "(not set: no inline comments)",
        ),
        textField(
          "commitId",
          "Head commit the review is pinned to (must be the pull request's current head)",
          "(not set: refused, the review must name the head commit)",
        ),
      ],
    }),
    {
      tool: "github_pr_get",
      // `commitId` is declared for the guard, never sent to the read.
      argKeys: ["owner", "repo", "pullNumber", "commitId"],
      args: githubPrReadArgs,
      select: selectGithubPrReviewTarget,
      guard: GITHUB_REVIEW_HEAD_GUARD,
    },
  ),
];
