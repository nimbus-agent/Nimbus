// packages/gateway/src/connectors/connector-writes/bitbucket-comment-rows.ts
// The Bitbucket pull request comment (`@nimbus-dev/connectors` PR 106): a Wave 2 comment like
// `github_issue_comment_create` and `gitlab_mr_note_create`, kept out of `vcs-ci.ts`, whose size is
// locked by `audit:file-size`. Spread into the one row table by `index.ts`.
import { type ConnectorWriteRow, row, textField, withPreview } from "./types.ts";

// The template names every key of the connector's schema, so the drift check offers it. `path`
// makes the comment inline on that file, and `line` on that line of the file's new version; the
// connector refuses a `line` without a `path` before it sends anything.
export const BITBUCKET_COMMENT_ROWS: readonly ConnectorWriteRow[] = [
  withPreview(row("bitbucket_pr_comment_create", "bitbucket.pr.comment.create", "mesh", 2), {
    target: "{repoFull}#{pullRequestId}",
    summary: "Comment on Bitbucket pull request {repoFull}#{pullRequestId}",
    fields: [
      textField("body", "Comment"),
      textField("path", "File", "(not set: a comment on the whole pull request)"),
      textField("line", "Line (in the new version of the file)", "(not set: no line)"),
    ],
  }),
];
