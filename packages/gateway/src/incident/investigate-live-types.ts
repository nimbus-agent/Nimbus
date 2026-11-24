/**
 * The shape of a LIVE investigation block (owner ruling 9, `nimbus incident investigate --live`). Pure types: the
 * reads that fill it live in `investigation/investigation-live.ts`, outside `incident/` (static D46(a), I57 (a)),
 * and nothing here is ever stored in an incident record. Every string is provider text, capped to one line by the
 * reader and escaped again by the renderer.
 */

/** One live Sentry issue that is correlated with the incident: of a bound project, active inside its window. */
export type LiveIssueRow = {
  readonly issueId: string;
  readonly title: string;
  readonly url: string | null;
  readonly project: string;
  readonly level: string | null;
  readonly status: string | null;
  readonly count: number | null;
  readonly userCount: number | null;
  readonly firstSeenMs: number | null;
  readonly lastSeenMs: number;
  /** Timing only: first seen at or after the record's deployment start. */
  readonly newSinceDeploy: boolean;
};

/** What became of the read of one project: a FIXED word, never error text. */
export type LiveProjectOutcome =
  | "read"
  | "timeout"
  | "refused"
  | "failed"
  | "unreadable"
  | "skipped_budget"
  | "skipped_cap";

export type LiveBlock = {
  readonly backend: "sentry";
  /** The wall-clock budget the reads shared, in milliseconds. */
  readonly budgetMs: number;
  /** `ok`: every project was read. `partial`: some were not. `not_read`: none was (see the gaps). */
  readonly status: "ok" | "partial" | "not_read";
  readonly projects: readonly {
    readonly project: string;
    readonly outcome: LiveProjectOutcome;
    /** Issues the reply held (after the shape check), before the window filter. */
    readonly scanned: number;
    /** Issues that were correlated (inside the window). */
    readonly matched: number;
  }[];
  readonly rows: readonly LiveIssueRow[];
  /** Every correlated issue, shown or not. */
  readonly total: number;
};
