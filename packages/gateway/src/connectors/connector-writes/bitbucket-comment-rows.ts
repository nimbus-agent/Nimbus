// packages/gateway/src/connectors/connector-writes/bitbucket-comment-rows.ts
// The Bitbucket pull request comment (`@nimbus-dev/connectors` PR 106): a Wave 2 comment like
// `github_issue_comment_create` and `gitlab_mr_note_create`, kept out of `vcs-ci.ts`, whose size is
// locked by `audit:file-size`. Spread into the one row table by `index.ts`.
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
  type ConnectorWriteRow,
  row,
  textField,
  withBefore,
  withPreview,
} from "./types.ts";
import { bitbucketPrReadArgs } from "./vcs-ci-readers.ts";

/**
 * Bitbucket `bitbucket_pr_get` (before-state) for a comment: what `#N` is. `Title` (required, so a
 * reply without one reads `Before: unavailable`), `State` and `Branches` (`source -> destination`,
 * only when both are known). Never the description (the same rule as `selectGitlabMrIdentity`).
 */
export function selectBitbucketPrIdentity(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const title = requiredStringAt(j, ["title"]);
  const source = stringAt(j, ["source", "branch", "name"]);
  const destination = stringAt(j, ["destination", "branch", "name"]);
  const branches =
    source === undefined || destination === undefined ? undefined : `${source} -> ${destination}`;
  return [
    { label: "Title", value: excerptHead(title) },
    ...presentFields([
      ["State", shownHead(stringAt(j, ["state"]))],
      ["Branches", shownHead(branches)],
    ]),
  ];
}

// The template names every key of the connector's schema, so the drift check offers it. `path`
// makes the comment inline on that file, and `line` on that line of the file's new version; the
// connector refuses a `line` without a `path` before it sends anything. The reader is the one the
// `bitbucket_pr_merge` row uses (`bitbucket_pr_get` with exactly the repository and the id).
export const BITBUCKET_COMMENT_ROWS: readonly ConnectorWriteRow[] = [
  withBefore(
    withPreview(row("bitbucket_pr_comment_create", "bitbucket.pr.comment.create", "mesh", 2), {
      target: "{repoFull}#{pullRequestId}",
      summary: "Comment on Bitbucket pull request {repoFull}#{pullRequestId}",
      fields: [
        textField("body", "Comment"),
        textField("path", "File", "(not set: a comment on the whole pull request)"),
        textField("line", "Line (in the new version of the file)", "(not set: no line)"),
      ],
    }),
    {
      tool: "bitbucket_pr_get",
      argKeys: ["repoFull", "pullRequestId"],
      args: bitbucketPrReadArgs,
      select: selectBitbucketPrIdentity,
    },
  ),
];
