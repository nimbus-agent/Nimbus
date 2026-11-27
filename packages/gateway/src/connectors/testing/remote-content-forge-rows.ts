// packages/gateway/src/connectors/testing/remote-content-forge-rows.ts
// The forge Markdown rows of `@nimbus-dev/connectors` 0.19.0 for the remote-content door fixtures
// (`remote-content-fixtures.ts` spreads them into its forge row list, whose size is locked by
// `audit:file-size`): the GitHub and GitLab issue edits, and the pull request review with the form
// in its body and in an inline comment's body (`comments[].body`, `nested-text-refusals.ts`).
import type { RemoteContentDoorCase } from "./remote-content-fixtures.ts";

function forgeRow(prefix: string, toolId: string, input: Readonly<Record<string, unknown>>) {
  return (label: string): RemoteContentDoorCase => ({
    label: `${prefix}: ${label}`,
    toolId,
    input,
  });
}

const PR = { owner: "o", repo: "r", pullNumber: 3, event: "COMMENT" } as const;

/** Each builds one case with `body` in the row's scanned field. */
export const FORGE_ROWS_0_19: readonly ((label: string, body: string) => RemoteContentDoorCase)[] =
  [
    (l, body) =>
      forgeRow("github issue update", "github_issue_update", {
        owner: "o",
        repo: "r",
        issueNumber: 1,
        body,
      })(l),
    (l, description) =>
      forgeRow("gitlab issue update", "gitlab_issue_update", {
        projectPath: "g/r",
        issueIid: 7,
        description,
      })(l),
    (l, body) => forgeRow("github review", "github_pr_review_create", { ...PR, body })(l),
    (l, body) =>
      forgeRow("github review inline comment", "github_pr_review_create", {
        ...PR,
        body: "Looks fine",
        comments: [
          { path: "src/a.ts", line: 4, body: "ok" },
          { path: "src/b.ts", line: 9, body },
        ],
      })(l),
  ];
