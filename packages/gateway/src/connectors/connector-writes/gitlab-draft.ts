// packages/gateway/src/connectors/connector-writes/gitlab-draft.ts
// Phase 9.7 C2: whether a GitLab merge request title reads as a draft. DISPLAY ONLY: it feeds the
// `Draft state` line of the `gitlab_mr_update` preview and is never a security decision.
//
// Two verdicts, so the line never states what GitLab might contradict:
//  - EXACT: GitLab's own rule, applied to the RAW title. gitlab-org/gitlab master (retrieved
//    2026-11-06): lib/gitlab/regex/merge_requests.rb `merge_request_draft =
//    /\A(?i)(\[draft\]|\(draft\)|draft:)/` and app/models/merge_request.rb `DRAFT_REGEX`. It is
//    anchored at the start, case-insensitive, does no Unicode folding, no whitespace trimming and
//    no entity decoding, and WIP is no longer a marker.
//  - FOLDED: a superset that settles the title first (NFKC, invisibles deleted, entities decoded,
//    lower-case) and also accepts `wip` and leading whitespace.
// When the two disagree the preview says UNCERTAIN rather than guess which one GitLab applies.
import { settle } from "./text-normalise.ts";

const DRAFT_PREFIX = /^\s*(?:(?:draft|wip):|\[(?:draft|wip)\]|\((?:draft|wip)\))/;
const GITLAB_DRAFT = /^(?:\[draft\]|\(draft\)|draft:)/i;

/** GitLab's exact verdict: the raw title starts with `[Draft]`, `(Draft)` or `Draft:`. */
export function gitlabTitleIsDraftExact(title: string): boolean {
  return GITLAB_DRAFT.test(title);
}

/** Whether `title` starts with a draft marker (superset detector; `true` when it cannot be read). */
export function gitlabTitleLooksDraft(title: string): boolean {
  const settled = settle(title, "");
  if (settled === undefined) return true;
  return DRAFT_PREFIX.test(settled);
}
