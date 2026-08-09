import { createGitHubApi, type GitHubApi, type IssueRef } from "./gh-api.ts";

export const HEALTH_LABEL = "release-health";
export function markerFor(key: string): string {
  return `<!-- release-health:${key} -->`;
}
const STATE_RE = /<!-- release-health-state:([a-f0-9]+) -->/;

export function selectExistingIssue(issues: readonly IssueRef[], key: string): IssueRef | null {
  const marker = markerFor(key);
  const matches = issues.filter((i) => i.body.includes(marker));
  if (matches.length === 0) return null;
  return matches.reduce((oldest, i) => (i.createdAt < oldest.createdAt ? i : oldest));
}

export function computeStateHash(state: string): string {
  // Bun exposes a fast non-crypto hasher; stable across runs for identical input.
  return Bun.hash(state).toString(16);
}

export function readStateHash(body: string): string | null {
  return STATE_RE.exec(body)?.[1] ?? null;
}

export function shouldComment(prevHash: string | null, nextHash: string): boolean {
  return prevHash !== nextHash;
}

function composeBody(key: string, body: string, stateHash: string): string {
  return `${markerFor(key)}\n<!-- release-health-state:${stateHash} -->\n\n${body}`;
}

export async function openOrUpdateHealthIssue(
  api: GitHubApi,
  args: { key: string; title: string; body: string; state: string },
): Promise<void> {
  const stateHash = computeStateHash(args.state);
  const fullBody = composeBody(args.key, args.body, stateHash);
  const existing = selectExistingIssue(await api.listOpenIssues(HEALTH_LABEL), args.key);
  if (existing === null) {
    await api.ensureLabel(HEALTH_LABEL);
    await api.createIssue(args.title, fullBody, [HEALTH_LABEL]);
    return;
  }
  await api.updateIssue(existing.number, fullBody);
  if (shouldComment(readStateHash(existing.body), stateHash)) {
    await api.commentIssue(existing.number, `State changed:\n\n${args.body}`);
  }
}

export async function closeHealthIssue(
  api: GitHubApi,
  key: string,
  comment: string,
): Promise<void> {
  const existing = selectExistingIssue(await api.listOpenIssues(HEALTH_LABEL), key);
  if (existing !== null) await api.closeIssue(existing.number, comment);
}

if (import.meta.main) {
  const repo = process.env["GITHUB_REPOSITORY"];
  const token = process.env["GITHUB_TOKEN"];
  const key = process.env["HEALTH_KEY"];
  const title = process.env["HEALTH_TITLE"];
  const body = process.env["HEALTH_BODY"];
  // `HEALTH_RESOLVE` closes the issue this key owns instead of opening one. A
  // recurring-failure alert needs BOTH halves: without a resolve path, a stable
  // key leaves an issue open after the fault clears, and an alert that stays red
  // once fixed is one people learn to scroll past — the disease, not the cure.
  // No open issue for the key is success, not an error: nothing to close.
  const resolve = (process.env["HEALTH_RESOLVE"] ?? "") !== "";
  if (!repo || !token || !key || !body) {
    console.error(
      "open-health-issue: GITHUB_REPOSITORY, GITHUB_TOKEN, HEALTH_KEY, HEALTH_BODY required",
    );
    process.exit(2);
  }
  const api = createGitHubApi({ token, repo });
  if (resolve) {
    await closeHealthIssue(api, key, body);
  } else {
    if (!title) {
      console.error("open-health-issue: HEALTH_TITLE required unless HEALTH_RESOLVE is set");
      process.exit(2);
    }
    await openOrUpdateHealthIssue(api, { key, title, body, state: body });
  }
}
