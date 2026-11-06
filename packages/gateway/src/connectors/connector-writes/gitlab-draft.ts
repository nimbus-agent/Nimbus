// packages/gateway/src/connectors/connector-writes/gitlab-draft.ts
// Phase 9.7 C2: whether a GitLab merge request title reads as a draft. DISPLAY ONLY: it feeds the
// `Draft state` line of the `gitlab_mr_update` preview and is never a security decision, so it
// deliberately errs towards "draft" (a false "marks as draft" line is harmless, a missed one is
// not). GitLab documents `[Draft]`, `Draft:` or `(Draft)` at the START of the title as the draft
// marker (https://docs.gitlab.com/user/project/merge_requests/drafts/); that page says nothing on
// `WIP`, letter case or leading whitespace, so those are extras of this detector, not claims.
import { settle } from "./text-normalise.ts";

const DRAFT_PREFIX = /^\s*(?:(?:draft|wip):|\[(?:draft|wip)\]|\((?:draft|wip)\))/;

/** Whether `title` starts with a draft marker (superset detector; `true` when it cannot be read). */
export function gitlabTitleLooksDraft(title: string): boolean {
  const settled = settle(title, "");
  if (settled === undefined) return true;
  return DRAFT_PREFIX.test(settled);
}
