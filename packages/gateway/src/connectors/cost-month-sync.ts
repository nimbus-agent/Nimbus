// Phase 7 (the Cost Pack, slices 5 and 6): the month-by-month loop every cost sync shares (GitHub billing,
// OpenAI costs, Anthropic costs). A sync reads, per ACCOUNT (a GitHub org; the one organization an OpenAI or
// Anthropic admin key belongs to), the current UTC month, plus the previous month until the 5th (vendors restate
// days of a month that just closed) or on the account's first sync, plus any month an earlier run could not
// finish. The first gap or retry stops that account and leaves the rest pending; its cursor
// (`finops/cost-source-gaps.ts`) carries the gaps, the last sync day and the pending months. Cursor maps are read
// as OWN properties (an org may be named `constructor`).
import type { CostSyncCursor } from "../finops/cost-source-gaps.ts";

const RESTATEMENT_DAYS = 5;

/** What fetching one month of one account came to. */
export type CostMonthOutcome =
  | {
      readonly kind: "ok";
      readonly lines: number;
      readonly bytes: number;
      /** The month was written but its source may still restate it (AWS `Estimated`): it stays pending. */
      readonly pending?: boolean;
    }
  /** A stated gap for the ACCOUNT (no access, refused): shown; no write; this and older months stay pending. */
  | { readonly kind: "gap"; readonly reason: string }
  /**
   * A stated gap for THIS MONTH only (rows that could not be read): shown; this month is kept as stored and stays
   * pending, and the older months are still fetched.
   */
  | { readonly kind: "month_gap"; readonly reason: string }
  /** A transient failure: no write; the earlier gap (if any) is kept; the month stays pending. */
  | { readonly kind: "retry" };

/** An entry of a cursor map, read as an OWN property. */
export function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The required months at `nowMs` (`YYYY-MM`, the current first). */
export function requiredCostMonths(nowMs: number, firstSync: boolean): string[] {
  const now = new Date(nowMs);
  const current = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previous = prev.toISOString().slice(0, 7);
  return firstSync || now.getUTCDate() <= RESTATEMENT_DAYS ? [current, previous] : [current];
}

/** The months to fetch: the required ones and any pending, never a future month, newest first. */
export function costMonthsToFetch(
  nowMs: number,
  firstSync: boolean,
  pending: readonly string[],
): string[] {
  const current = new Date(nowMs).toISOString().slice(0, 7);
  const all = new Set([...requiredCostMonths(nowMs, firstSync), ...pending]);
  return [...all].filter((m) => m <= current).sort((a, b) => (a < b ? 1 : -1));
}

export type CostSyncRun = {
  readonly cursor: CostSyncCursor;
  readonly lines: number;
  readonly bytes: number;
};

/**
 * Runs every account's months through `fetchMonth`, one request at a time, and builds the next cursor: only the
 * accounts passed are kept (an account removed and added back is a first sync again), a gap replaces the earlier
 * one, a retry keeps it, a success clears it.
 */
export async function runCostAccounts(
  prev: CostSyncCursor,
  accounts: readonly string[],
  nowMs: number,
  fetchMonth: (account: string, month: string) => Promise<CostMonthOutcome>,
): Promise<CostSyncRun> {
  const gaps: Record<string, string> = {};
  const synced: Record<string, string> = {};
  const pending: Record<string, string[]> = {};
  for (const a of accounts) {
    const day = own(prev.synced, a);
    if (day !== undefined) synced[a] = day;
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  let lines = 0;
  let bytes = 0;
  for (const account of accounts) {
    const months = costMonthsToFetch(
      nowMs,
      own(synced, account) === undefined,
      own(prev.pending, account) ?? [],
    );
    let gap: string | null = null;
    let monthGap: string | null = null;
    let retried = false;
    const unfinished: string[] = [];
    for (const [i, month] of months.entries()) {
      const r = await fetchMonth(account, month); // NOSONAR S9382: one request at a time through the vendor's rate limiter
      if (r.kind === "ok") {
        lines += r.lines;
        bytes += r.bytes;
        if (r.pending === true) unfinished.push(month);
        continue;
      }
      if (r.kind === "month_gap") {
        monthGap ??= r.reason;
        unfinished.push(month);
        continue;
      }
      if (r.kind === "gap") gap = r.reason;
      else retried = true;
      unfinished.push(...months.slice(i));
      break;
    }
    if (unfinished.length > 0) pending[account] = unfinished;
    const earlierGap = own(prev.gaps, account);
    const shown = gap ?? monthGap ?? (retried ? (earlierGap ?? null) : null);
    if (shown !== null) gaps[account] = shown;
    // The account was read (an unreadable MONTH does not change that); the months it missed are pending, not lost.
    if (gap === null) synced[account] = today;
  }
  return { cursor: { gaps, synced, pending }, lines, bytes };
}
