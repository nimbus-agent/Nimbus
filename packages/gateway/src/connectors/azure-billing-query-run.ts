// Phase 7 (the Cost Pack, slice 12b): the Query API fallback of the `azure_billing` sync, run when no
// `[cost.azure] export` is set. Each configured scope is one ACCOUNT of the month loop; its lines are written once
// per (scope, month) through `replaceCostLinesForMonth` (D24), whole month or nothing.
import type { CostLine } from "../finops/cost-line.ts";
import type { CostSyncCursor } from "../finops/cost-source-gaps.ts";
import type { SyncContext } from "../sync/types.ts";
import type { AzureFetch, AzureTokenSource } from "./_lib/azure-token.ts";
import { AZURE_COST_PROVIDER } from "./azure-billing-export.ts";
import {
  type AzureQueryClient,
  azureQueryClient,
  readAzureQueryMonth,
} from "./azure-cost-query.ts";
import {
  type CostMonthOutcome,
  type CostSyncRun,
  own,
  runCostAccounts,
} from "./cost-month-sync.ts";

/** The last UTC day of `month` (`YYYY-MM`) that is not after `today` (`YYYY-MM-DD`). */
export function lastQueryDay(month: string, today: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return end < today ? end : today;
}

const DAY_MS = 86_400_000;
/** How long a stated "empty answer" gap stands before the query is asked again: a day now, a week for a past month. */
export const AZURE_EMPTY_RETRY_DAYS = { current: 1, past: 7 } as const;

const emptyReason = (scope: string, month: string, days: number): string =>
  `the ${month} cost query for ${scope} returned no rows but lines are stored; that month was not updated (asked again every ${String(days)} day${days === 1 ? "" : "s"})`;

/** Writes one scope's month; the days the query returned replace those days, every other stored day is kept. */
function writeMonth(
  ctx: SyncContext,
  scope: string,
  month: string,
  lines: readonly CostLine[],
  onEmpty: () => CostMonthOutcome,
): CostMonthOutcome {
  const target = { provider: AZURE_COST_PROVIDER, billingAccountId: scope, month };
  try {
    const stored = ctx.readOwnCostLinesForMonth(target);
    // An empty answer for a month that holds lines never clears it.
    if (lines.length === 0) {
      return stored.length > 0 ? onEmpty() : { kind: "ok", lines: 0, bytes: 0 };
    }
    const covered = new Set(lines.map((l) => l.chargeDay));
    ctx.replaceCostLinesForMonth(target, [
      ...stored.filter((l) => !covered.has(l.chargeDay)),
      ...lines,
    ]);
  } catch (e) {
    ctx.logger.warn(
      { serviceId: "azure_billing", month, err: e instanceof Error ? e.message : String(e) },
      "azure_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: lines.length, bytes: 0 };
}

export interface AzureQueryRunInput {
  readonly ctx: SyncContext;
  readonly prev: CostSyncCursor;
  /** Scopes without leading or trailing slashes (see `normaliseAzureScope`). */
  readonly scopes: readonly string[];
  readonly nowMs: number;
  readonly tokens: AzureTokenSource;
  readonly fetch: AzureFetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly client?: AzureQueryClient;
}

export async function runAzureQuery(input: AzureQueryRunInput): Promise<CostSyncRun> {
  const client =
    input.client ?? azureQueryClient(input.ctx, input.tokens, input.fetch, input.sleep);
  const today = new Date(input.nowMs).toISOString().slice(0, 10);
  const emptyScan: Record<string, string> = {};
  const run = await runCostAccounts(input.prev, input.scopes, input.nowMs, async (scope, month) => {
    // After a 429 the quota is not asked again this run: the remaining scopes and months stay pending.
    if (client.throttled?.() === true) return { kind: "retry" };
    const key = `${scope}|${month}`;
    const days =
      month === today.slice(0, 7) ? AZURE_EMPTY_RETRY_DAYS.current : AZURE_EMPTY_RETRY_DAYS.past;
    const last = own(input.prev.emptyScan ?? {}, key);
    // A month whose last answer was empty is not asked again until the interval has passed (no QPU spent).
    if (last !== undefined && input.nowMs - Date.parse(`${last}T00:00:00Z`) < days * DAY_MS) {
      emptyScan[key] = last;
      return { kind: "month_gap", reason: emptyReason(scope, month, days) };
    }
    const read = await readAzureQueryMonth(client, scope, month, lastQueryDay(month, today));
    if (!Array.isArray(read)) return read as CostMonthOutcome;
    return writeMonth(input.ctx, scope, month, read as CostLine[], () => {
      emptyScan[key] = today;
      return { kind: "month_gap", reason: emptyReason(scope, month, days) };
    });
  });
  return Object.keys(emptyScan).length === 0
    ? run
    : { ...run, cursor: { ...run.cursor, emptyScan } };
}
