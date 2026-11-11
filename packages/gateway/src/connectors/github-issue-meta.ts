import { msFromIso } from "./ticket-depth.ts";
import { asRecord, stringField } from "./unknown-record.ts";

/**
 * The depth of a GitHub issue row (Phase 10 MB1): the milestone and its due date, under the same
 * `due_at_ms` key Jira and Linear use. A value the API did not supply omits its key (omission over
 * guessing), so a consumer reads a missing `due_at_ms` as "no due date known".
 *
 * NOT in `REBODY_META_TARGETS`: the only writers of an issue row are the events feed (it has no issue
 * list, so an old row could never be re-walked to this version, and a registered target would stay
 * pending forever) and the open-work snapshot, which refreshes its own members within one interval.
 */
export const GITHUB_ISSUE_META_VERSION = 1;

export function githubIssueDepthMetadata(issue: Record<string, unknown>): Record<string, unknown> {
  const meta: Record<string, unknown> = { meta_v: GITHUB_ISSUE_META_VERSION };
  const milestone = asRecord(issue["milestone"]);
  if (milestone === undefined) return meta;
  const due = msFromIso(stringField(milestone, "due_on"));
  if (due !== undefined) meta["due_at_ms"] = due;
  const title = stringField(milestone, "title");
  if (title !== undefined && title !== "") meta["milestone"] = title;
  return meta;
}

/** `<repo>#issue-<n>`: the one spelling of an issue's external id (events feed and snapshot). */
export function githubIssueExternalId(repoFull: string, num: number): string {
  return `${repoFull}#issue-${String(num)}`;
}

/**
 * `owner/repo` from a Search hit's `repository_url` (`<restRoot>/repos/<owner>/<repo>`, which also
 * holds on GHES), or `undefined` for any other shape.
 */
export function repoFullFromRepositoryUrl(url: string): string | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const at = path.lastIndexOf("/repos/");
  if (at < 0) return undefined;
  const parts = path.slice(at + "/repos/".length).split("/");
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts as [string, string];
  return owner === "" || repo === "" ? undefined : `${owner}/${repo}`;
}
