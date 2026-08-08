/**
 * Shared depth helpers for the ticket connectors (Jira, Linear).
 *
 * `status_category` is normalized HERE rather than passed through, because the
 * two platforms disagree on vocabulary and a raw value would force every
 * consumer to branch on service. The platform's own value is preserved
 * alongside it as `status_category_raw`, so normalizing never destroys
 * information.
 */

export type TicketStatusCategory = "todo" | "in_progress" | "done" | "canceled" | "unknown";

/** Bump when a mapper starts writing a key consumers may rely on. Drives `rebody` eligibility. */
export const TICKET_META_VERSION = 1;

const JIRA_STATUS_CATEGORY: Readonly<Record<string, TicketStatusCategory>> = {
  new: "todo",
  indeterminate: "in_progress",
  // Jira folds "Won't Do" / "Canceled" resolutions into `done`; the
  // distinction lives in `fields.resolution`, which the sync does not fetch.
  // So `canceled` is unreachable on Jira by construction, not by omission.
  done: "done",
};

const LINEAR_STATE_TYPE: Readonly<Record<string, TicketStatusCategory>> = {
  backlog: "todo",
  unstarted: "todo",
  started: "in_progress",
  completed: "done",
  canceled: "canceled",
};

function lookup(
  table: Readonly<Record<string, TicketStatusCategory>>,
  raw: string | undefined,
): TicketStatusCategory {
  if (raw === undefined || raw === "") {
    return "unknown";
  }
  // An unrecognized value must NOT fall back to "todo" — that reads as "not
  // started yet" and would quietly distort every cohort a consumer builds.
  return table[raw] ?? "unknown";
}

export function normalizeJiraStatusCategory(raw: string | undefined): TicketStatusCategory {
  return lookup(JIRA_STATUS_CATEGORY, raw);
}

export function normalizeLinearStateType(raw: string | undefined): TicketStatusCategory {
  return lookup(LINEAR_STATE_TYPE, raw);
}

/**
 * Epoch milliseconds from an ISO-8601 string, or `undefined` when the value is
 * absent or unparseable. Never 0 and never NaN: a consumer must be able to
 * tell "no due date" from "due at the epoch".
 */
export function msFromIso(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}
