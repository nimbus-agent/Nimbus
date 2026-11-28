// Phase 7 (the Cost Pack, slice 11b; owner ruling D7): reading AWS Cost Explorer through the AWS CLI. It runs ONLY
// when `[cost.aws] cost_explorer = true` and no `export` is set (`aws-billing-cost-sync.ts` decides); a Cost
// Explorer API request is billed at USD 0.01 each (https://aws.amazon.com/aws-cost-management/pricing/), which is
// why it is opt-in and bounded: at most `AWS_CE_MAX_PAGES` requests per month and run, past which the month is a
// `month_gap` with nothing written.
//
// The billing account is the Organizations management account (`aws organizations describe-organization`) when the
// credentials may read it, else the `aws sts get-caller-identity` Account. It is the account a FOCUS export names
// as `BillingAccountId`, so a later switch to the export replaces the same (provider, account, month) tuple.
import { AWS_CE_PROVIDER, AWS_CE_SOURCE, awsCeLines } from "../finops/aws-ce-lines.ts";
import type { CostLine } from "../finops/cost-line.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  AWS_CLI_TIMEOUT_MS,
  awsCliJson,
  awsNextToken,
  extractArray,
  parseJson,
} from "./_lib/aws-cli.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { asRecord, stringField } from "./unknown-record.ts";

export { AWS_CE_PROVIDER, AWS_CE_SOURCE };
/** Requests for one month in one run; each is billed (USD 0.01). One day-by-service-by-account page is large. */
export const AWS_CE_MAX_PAGES = 10;
/** The month loop's account key while Cost Explorer is the source (the cursor keeps no AWS account id). */
export const AWS_CE_ACCOUNT_KEY = "aws-cost-explorer";
const ACCOUNT_ID_RE = /^\d{12}$/;

export const AWS_CE_GAPS = {
  account:
    "the AWS account id could not be read (aws sts get-caller-identity failed); Cost Explorer was not queried",
  read: "AWS Cost Explorer could not be read (check Cost Explorer is enabled and the credentials allow ce:GetCostAndUsage)",
} as const;

/** What the sync needs of the AWS CLI for Cost Explorer; credentials are bound in, and a test passes a fake. */
export interface AwsCeCli {
  run(args: string[]): Promise<{ ok: boolean; text: string }>;
}

export function awsCeCli(ctx: SyncContext): AwsCeCli {
  return { run: (args) => awsCliJson(ctx, args, AWS_CLI_TIMEOUT_MS) };
}

/** Counts every billed request of a run (the Cost Explorer ones). */
export interface CeRequestCounter {
  requests: number;
}

async function call(
  ctx: SyncContext,
  cli: AwsCeCli,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  await ctx.rateLimiter.acquire("aws"); // NOSONAR S9382: one CLI call at a time through the AWS limiter
  return cli.run(args); // NOSONAR S9382
}

function idOf(text: string, ...fields: string[]): string | null {
  const root = asRecord(parseJson(text));
  const nested = asRecord(root?.["Organization"]) ?? root;
  for (const f of fields) {
    const v = nested === undefined ? undefined : stringField(nested, f);
    if (v !== undefined && ACCOUNT_ID_RE.test(v)) return v;
  }
  return null;
}

/** The management account when Organizations is readable, else the caller's account; null when neither is. */
export async function resolvePayerAccount(ctx: SyncContext, cli: AwsCeCli): Promise<string | null> {
  const org = await call(ctx, cli, ["organizations", "describe-organization"]);
  if (org.ok) {
    const id = idOf(org.text, "ManagementAccountId", "MasterAccountId");
    if (id !== null) return id;
  }
  const who = await call(ctx, cli, ["sts", "get-caller-identity"]);
  return who.ok ? idOf(who.text, "Account") : null;
}

export type CeMonthRead =
  | {
      readonly kind: "lines";
      readonly lines: readonly CostLine[];
      readonly days: ReadonlySet<string>;
      readonly estimated: boolean;
    }
  | CostMonthOutcome;

const monthGap = (reason: string): CostMonthOutcome => ({ kind: "month_gap", reason });
const DAY_MS = 86_400_000;

/** `[start, end)` of the month, the end clamped to tomorrow (UTC) so a running month asks for no future day. */
export function ceTimePeriod(month: string, nowMs: number): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const start = `${month}-01`;
  const next = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(Math.floor(nowMs / DAY_MS) * DAY_MS + DAY_MS)
    .toISOString()
    .slice(0, 10);
  // Both are `YYYY-MM-DD`, so the text order is the date order.
  let end = next;
  if (tomorrow < end) end = tomorrow;
  return { start, end };
}

/**
 * One month's daily cost by service and linked account. Every page is read or the month is a `month_gap` (no
 * partial write); the page cap, a token that does not advance and an unreadable or unreadable-in-part response
 * all end that way. `counter` counts the billed requests.
 */
export async function readCeMonth(
  ctx: SyncContext,
  cli: AwsCeCli,
  payer: string,
  month: string,
  nowMs: number,
  counter: CeRequestCounter,
): Promise<CeMonthRead> {
  const { start, end } = ceTimePeriod(month, nowMs);
  if (end <= start) return { kind: "ok", lines: 0, bytes: 0 };
  const results: unknown[] = [];
  let token: string | null = null;
  for (let page = 0; page < AWS_CE_MAX_PAGES; page++) {
    counter.requests++;
    const res = await call(ctx, cli, [
      "ce",
      "get-cost-and-usage",
      "--time-period",
      `Start=${start},End=${end}`,
      "--granularity",
      "DAILY",
      "--metrics",
      "UnblendedCost",
      "AmortizedCost",
      "UsageQuantity",
      "--group-by",
      "Type=DIMENSION,Key=SERVICE",
      "Type=DIMENSION,Key=LINKED_ACCOUNT",
      ...(token === null ? [] : ["--next-page-token", token]),
    ]);
    const parsed = res.ok ? parseJson(res.text) : undefined;
    if (parsed === undefined || asRecord(parsed) === undefined) {
      return page === 0 && !res.ok
        ? { kind: "gap", reason: AWS_CE_GAPS.read }
        : monthGap(
            `the ${month} Cost Explorer reply could not be read; that month was not updated`,
          );
    }
    results.push(...extractArray(parsed, "ResultsByTime"));
    const next = awsNextToken(parsed, "NextPageToken");
    if (next === null) {
      const mapped = awsCeLines(payer, month, results, `${AWS_CE_SOURCE}:ce:${month}`);
      if (mapped.skipped > 0) {
        return monthGap(
          `${String(mapped.skipped)} Cost Explorer rows of ${month} could not be read; that month was not updated`,
        );
      }
      return { kind: "lines", ...mapped };
    }
    if (next === token) {
      return monthGap(
        `the ${month} Cost Explorer page token did not advance; that month was not updated`,
      );
    }
    token = next;
  }
  return monthGap(
    `the ${month} Cost Explorer reply needs more than ${String(AWS_CE_MAX_PAGES)} requests (each is billed); that month was not updated`,
  );
}
