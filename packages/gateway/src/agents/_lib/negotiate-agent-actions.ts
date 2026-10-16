import type { Database } from "bun:sqlite";

import { CaptureStore } from "../../mcp-sink/capture-store.ts";
import { canonicalizeUrl } from "../../util/url-canonical.ts";
import type { NegotiateAgentActions } from "./negotiate-types.ts";

/** The `negotiate` lanes an agent-proposed action can credit (the rest count nothing it makes). */
export type AgentActionLane = "tickets" | "writing";

/**
 * Proposable action types whose artifact lands in a `negotiate` lane after sync, and whether the
 * action CREATES that artifact or EDITS an existing one. Only a create is excluded when its
 * result URL resolves: an edited page or issue may be the subject's own work, so removing it would
 * understate them — an edit is disclosed instead (it can pull an item into the window via
 * `modified_at`). Types absent here (mail, calendar, Drive, comments) land in no lane at all.
 * `teams.message.postChat` is absent because chat messages are not synced.
 */
export const AGENT_ACTION_LANES: Readonly<
  Record<string, { readonly lane: AgentActionLane; readonly effect: "create" | "edit" }>
> = {
  "slack.message.post": { lane: "writing", effect: "create" },
  "teams.message.post": { lane: "writing", effect: "create" },
  "confluence.page.create": { lane: "writing", effect: "create" },
  "confluence.page.update": { lane: "writing", effect: "edit" },
  "notion.page.create": { lane: "writing", effect: "create" },
  "notion.page.update": { lane: "writing", effect: "edit" },
  "notion.block.append": { lane: "writing", effect: "edit" },
  "github.issue.create": { lane: "tickets", effect: "create" },
  "jira.issue.create": { lane: "tickets", effect: "create" },
  "jira.issue.update": { lane: "tickets", effect: "edit" },
  "linear.issue.create": { lane: "tickets", effect: "create" },
  "linear.issue.update": { lane: "tickets", effect: "edit" },
};

/** Per lane: the item ids to leave out of the subject's counts, and the in-window unmatched. */
export type AgentActionExclusions = Readonly<
  Record<AgentActionLane, { readonly itemIds: readonly string[]; readonly unmatched: number }>
>;

export const NO_AGENT_ACTIONS: AgentActionExclusions = {
  tickets: { itemIds: [], unmatched: 0 },
  writing: { itemIds: [], unmatched: 0 },
};

/**
 * Resolve every retained executed action to the indexed items it created. The match is
 * `canonicalizeUrl(outcome_ref)` against `item.resolve_key` — the one canonical form both sides
 * already share — so it is best-effort by construction: no URL returned (Teams), a URL the sync
 * does not store (Slack without a known subdomain), or not yet synced all fall to `unmatched`.
 *
 * Exclusion is NOT windowed (an item the agent created is never the subject's, whenever it ran);
 * `unmatched` IS windowed on the action's finish time, since it discloses activity in this window.
 */
export function agentActionExclusions(db: Database, cutoffMs: number): AgentActionExclusions {
  const ids: Record<AgentActionLane, Set<string>> = { tickets: new Set(), writing: new Set() };
  const unmatched: Record<AgentActionLane, number> = { tickets: 0, writing: 0 };
  const byKey = db.query("SELECT id FROM item WHERE resolve_key = ?");
  try {
    for (const a of new CaptureStore(db).executedActions()) {
      const spec = AGENT_ACTION_LANES[a.actionType];
      if (spec === undefined) continue;
      const matched =
        spec.effect === "create" && a.outcomeRef !== null
          ? (byKey.all(canonicalizeUrl(a.outcomeRef)) as Array<{ id: string }>)
          : [];
      for (const m of matched) ids[spec.lane].add(m.id);
      if (matched.length === 0 && a.decidedAt >= cutoffMs) unmatched[spec.lane] += 1;
    }
  } finally {
    byKey.finalize();
  }
  return {
    tickets: { itemIds: [...ids.tickets].sort(), unmatched: unmatched.tickets },
    writing: { itemIds: [...ids.writing].sort(), unmatched: unmatched.writing },
  };
}

/** The lane's disclosure counts: `excluded` = what the lane counted with vs. without them. */
export function agentActionsSummary(
  countedInFull: number,
  countedAfterExclusion: number,
  unmatched: number,
): NegotiateAgentActions {
  return { excluded: countedInFull - countedAfterExclusion, unmatched };
}
