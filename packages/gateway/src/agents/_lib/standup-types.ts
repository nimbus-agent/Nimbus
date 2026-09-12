import type { GapNote } from "@nimbus-dev/sdk";

import type { StandupRow } from "../standup-queries.ts";
import type { SelfPersonSource } from "./self-person.ts";

/**
 * How many entries the WINDOW held, per lane — COMPLETE, never the number listed.
 *
 * The entry lists on `StandupBrief` are capped at `STANDUP_CATEGORY_CAP`; these counts are not.
 * A window holding 61 Slack messages reports `messages: 61` beside a 50-entry list, and the
 * per-lane truncation is recoverable as `counts.messages - messages.length`.
 *
 * The ambiguity is invisible and is worth stating, because it shipped once on `changelog`: an
 * earlier version of that brief set each count to the POST-cap length, so the same window
 * reported 50 with a single cross-lane "11 further entries were truncated" line from which
 * neither true number could be recovered. `synthesize.ts` hands this object to the model as
 * authoritative findings, so a count that quietly means "shown" becomes confident prose saying
 * fifty messages when sixty-one were posted.
 *
 * `StandupBrief.approximateCount` is on this SAME basis (every matched row, not every listed
 * one), so the two numbers in one brief can be read against each other.
 */
export type StandupCounts = {
  readonly prsActive: number;
  readonly prsMerged: number;
  readonly reviews: number;
  readonly ticketsOpened: number;
  readonly incidents: number;
  readonly messages: number;
};

/**
 * Who this standup is about, and how that was decided.
 *
 * `source` is on the brief rather than kept internal to the resolver because it changes how much
 * the reader should trust an empty section. `"git"` means the local `git config user.email`
 * matched an indexed person — strong. `"os"` means the OS username matched a GitHub login, which
 * is a heuristic that can land on a colleague with the same handle. `"override"` means
 * `[user] mePersonId` was taken verbatim and was never checked against the `person` table at
 * all (`self-person.ts` short-circuits on it), so it can name nobody.
 *
 * `"unresolved"` is deliberately NOT reachable here: `emitStandupBrief` refuses before building
 * a brief, because every lane would return nothing and an empty standup is a false claim about
 * someone's day — one this command exists to have pasted into a channel. The union member stays
 * because it is `SelfPersonSource`'s, not this brief's, and narrowing it would be a lie about
 * what the resolver can return.
 */
export type StandupIdentity = {
  readonly personId: string;
  readonly source: SelfPersonSource;
  /** `null` when no `person` row carries a name for this id — see `selectPersonDisplayName`. */
  readonly displayName: string | null;
};

export type StandupBrief = {
  readonly kind: "standup";
  readonly agentVersion: 1;
  readonly generatedAt: number;
  readonly latencyMs: number;
  readonly gaps: GapNote[];
  readonly query: {
    /**
     * The ABSOLUTE cutoff this brief windowed on, already converted from the caller's lookback
     * DURATION by `buildStandupBrief`. Named `sinceMs` to match every other brief's `query`,
     * and deliberately NOT the name the builder's INPUT carries — see
     * `BuildStandupArgs.lookbackMs`.
     */
    readonly sinceMs: number;
    readonly nowMs: number;
  };
  readonly identity: StandupIdentity;
  /** Unmerged PRs of mine the index touched in the window — `last_touch`, see the lane. */
  readonly prsActive: readonly StandupRow[];
  readonly prsMerged: readonly StandupRow[];
  readonly reviews: readonly StandupRow[];
  readonly ticketsOpened: readonly StandupRow[];
  readonly incidents: readonly StandupRow[];
  readonly messages: readonly StandupRow[];
  readonly counts: StandupCounts;
  /**
   * Distinct Slack threads the window's messages touched — the roadmap's own unit for this lane.
   * On the same pre-cap basis as `counts`.
   */
  readonly threadCount: number;
  /**
   * Entries that CAN sit in the wrong window, over every row the window matched — the same
   * PRE-CAP basis as `counts`, not the listed subset.
   *
   * Rows on a `last_touch` basis only, via `basisCanBeMisplaced`. Reviews and Slack messages are
   * excluded on purpose even though their timestamp comes from the `modified_at` column, because
   * those rows are written once per event and cannot be misplaced — see `standup-time-basis.ts`.
   * Counting them would inflate this number with entries the disclosure's warning does not
   * apply to, which is how a disclosure stops being read.
   */
  readonly approximateCount: number;
  /** Merged PRs of mine on a forge that writes no `merged_at`, so invisible to this brief. */
  readonly nonGithubMergedPrs: number;
  /** Per-lane entries dropped by the display cap, for the truncation disclosure. */
  readonly truncatedCount: number;
};
