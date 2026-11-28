// Phase 7 (the Cost Pack, slice 11a; owner rulings 2026-11-28): AWS cost lines from a FOCUS 1.0 CSV Data Export
// the owner created in S3 (`[cost.aws] export = "s3://bucket/prefix"`; nothing is read until that is set).
//
// A companion of `aws` (`aws_billing`): it reads the Vault's shared `aws.*` credentials through its grant and
// runs the AWS CLI (`connectors/_lib/aws-cli.ts`, the I1 scoped env). `aws-billing-export.ts` lists the export
// and reads one billing period; this file writes it. The "account" of the month loop is the export location; the
// cost lines' billing account is the FOCUS `BillingAccountId` (the payer account).
//
// Per period and billing account the lines are written ONCE through `replaceCostLinesForMonth` (D24), and only
// the days the export covers are replaced: the stored lines of every other day are supplied again unchanged
// (`readOwnCostLinesForMonth`), as a FOCUS file import replaces only the days its file covers. A billing account
// the export no longer lists keeps its lines.
//
// Slice 11b: with `cost_explorer = true` and NO export, the days come from AWS Cost Explorer instead
// (`aws-cost-explorer.ts`; USD 0.01 per request, bounded, opt-in). Cost Explorer is never queried otherwise.
import type { NimbusCostAwsConfig } from "../config/cost-aws-toml.ts";
import type { CostLine } from "../finops/cost-line.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { awsCredentialsExtra } from "./_lib/aws-cli.ts";
import {
  AWS_BILLING_SOURCE,
  AWS_COST_GAPS,
  AWS_COST_PROVIDER,
  type AwsBillingCli,
  awsBillingCli,
  type ExportListing,
  listExport,
  readExportMonth,
} from "./aws-billing-export.ts";
import {
  AWS_CE_ACCOUNT_KEY,
  AWS_CE_GAPS,
  type AwsCeCli,
  awsCeCli,
  type CeRequestCounter,
  readCeMonth,
  resolvePayerAccount,
} from "./aws-cost-explorer.ts";
import { type CostMonthOutcome, own, runCostAccounts } from "./cost-month-sync.ts";

export const AWS_BILLING_SERVICE_ID = AWS_BILLING_SOURCE;
const DAY_MS = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.aws_billing;
/** The cursor key of a gap that belongs to the configuration, not to an export location. */
const CONFIG_KEY = "aws";

export type AwsBillingCostSyncableOptions = {
  /**
   * `[cost.aws]`, read at every run so a config edit takes effect on the next one; null when the cost config
   * could not be read (the run then keeps its cursor whole).
   */
  readonly aws: () => NimbusCostAwsConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly cli?: AwsBillingCli;
  /** Test seam for the Cost Explorer calls (`ce`, `organizations`, `sts`). */
  readonly ce?: AwsCeCli;
};

type Group = { readonly account: string; readonly lines: CostLine[] };

function byBillingAccount(lines: readonly CostLine[]): Group[] {
  const m = new Map<string, CostLine[]>();
  for (const l of lines) {
    const held = m.get(l.billingAccountId);
    if (held === undefined) m.set(l.billingAccountId, [l]);
    else held.push(l);
  }
  return [...m].map(([account, ls]) => ({ account, lines: ls }));
}

/** One billing account's month: the export's days replace those days; every other stored day is kept. */
function writeGroup(
  ctx: SyncContext,
  month: string,
  g: Group,
  days?: ReadonlySet<string>,
): CostMonthOutcome | null {
  const target = { provider: AWS_COST_PROVIDER, billingAccountId: g.account, month };
  const covered = days ?? new Set(g.lines.map((l) => l.chargeDay));
  try {
    const kept = ctx.readOwnCostLinesForMonth(target).filter((l) => !covered.has(l.chargeDay));
    ctx.replaceCostLinesForMonth(target, [...kept, ...g.lines]);
  } catch (e) {
    ctx.logger.warn(
      {
        serviceId: AWS_BILLING_SERVICE_ID,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "aws_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return null;
}

type FetchMonth = (account: string, month: string) => Promise<CostMonthOutcome>;

/** The export path: one listing per run, then one billing period per month. */
function exportMonthFetcher(
  ctx: SyncContext,
  cli: AwsBillingCli,
  exportAt: { readonly bucket: string; readonly prefix: string },
  nowMs: number,
): FetchMonth {
  let listing: Promise<ExportListing> | null = null;
  const listOnce = (): Promise<ExportListing> =>
    (listing ??= listExport(ctx, cli, exportAt.bucket, exportAt.prefix));
  return async (_account, month) => {
    const l = await listOnce();
    if (l.kind === "gap") return { kind: "gap", reason: l.reason };
    const ref = l.periods.get(month);
    // A month the export has no folder for (it started later, or its first delivery is pending) is not a gap.
    if (ref === undefined) return { kind: "ok", lines: 0, bytes: 0 };
    const read = await readExportMonth(cli, exportAt.bucket, exportAt.prefix, ref, month);
    if (!Array.isArray(read)) return read as CostMonthOutcome;
    // A charge day after today cannot be written (the intake refuses it): a stated gap, not an endless retry.
    const today = new Date(nowMs).toISOString().slice(0, 10);
    const future = read.filter((l) => l.chargeDay > today).length;
    if (future > 0) {
      return {
        kind: "month_gap",
        reason: `${String(future)} rows of the ${month} export are dated after today; that month was not updated`,
      };
    }
    let written = 0;
    for (const g of byBillingAccount(read)) {
      const refused = writeGroup(ctx, month, g);
      if (refused !== null) return refused;
      written += g.lines.length;
    }
    return { kind: "ok", lines: written, bytes: 0 };
  };
}

/**
 * The Cost Explorer path (opt-in, no export): the payer account is resolved once per run, then each month is read
 * whole or not at all. The days the API answered for are replaced; other stored days stay. An answer with no cost
 * group at all never clears a month that holds lines. An `Estimated` month is written and stays pending.
 */
function ceMonthFetcher(
  ctx: SyncContext,
  ce: AwsCeCli,
  nowMs: number,
  counter: CeRequestCounter,
): FetchMonth {
  let payer: Promise<string | null> | null = null;
  return async (_account, month) => {
    payer ??= resolvePayerAccount(ctx, ce);
    const id = await payer;
    if (id === null) return { kind: "gap", reason: AWS_CE_GAPS.account };
    const read = await readCeMonth(ctx, ce, id, month, nowMs, counter);
    if (read.kind !== "lines") return read;
    if (read.lines.length === 0) {
      const held = ctx.readOwnCostLinesForMonth({
        provider: AWS_COST_PROVIDER,
        billingAccountId: id,
        month,
      });
      if (held.length > 0) {
        return {
          kind: "month_gap",
          reason: `Cost Explorer returned no cost for ${month}, which holds stored lines; that month was not updated`,
        };
      }
      return { kind: "ok", lines: 0, bytes: 0, pending: read.estimated };
    }
    const refused = writeGroup(ctx, month, { account: id, lines: [...read.lines] }, read.days);
    if (refused !== null) return refused;
    return { kind: "ok", lines: read.lines.length, bytes: 0, pending: read.estimated };
  };
}

export function createAwsBillingCostSyncable(options: AwsBillingCostSyncableOptions): Syncable {
  return {
    serviceId: AWS_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.aws();
      const prev0 = { gaps: {}, synced: {}, pending: {} };
      if (cfg === null) {
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0), 0);
      }
      const exportAt = cfg.export;
      const ceRequests: CeRequestCounter = { requests: 0 };
      const viaCostExplorer = exportAt === null && cfg.costExplorer;
      const accounts = ((): string[] => {
        if (exportAt !== null) return [`s3://${exportAt.bucket}/${exportAt.prefix}`];
        return viaCostExplorer ? [AWS_CE_ACCOUNT_KEY] : [];
      })();
      const prev = decodeCostSyncCursor(PREFIX, cursor);
      const keep = <T>(m: Readonly<Record<string, T>>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const a of accounts) {
          const v = own(m, a);
          if (v !== undefined) out[a] = v;
        }
        return out;
      };
      const idle = (gaps: Record<string, string>): SyncResult =>
        syncPassCursorSuccess(
          t0,
          0,
          encodeCostSyncCursor(PREFIX, {
            gaps,
            synced: keep(prev.synced),
            pending: keep(prev.pending),
          }),
          0,
        );
      if (exportAt === null && !cfg.costExplorer) {
        return idle({ [CONFIG_KEY]: AWS_COST_GAPS.notConfigured });
      }
      const extra = await awsCredentialsExtra(ctx);
      // No usable credentials: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (extra === null) return idle(keep(prev.gaps));
      const nowMs = (options.now ?? Date.now)();
      const fetchMonth =
        exportAt === null
          ? ceMonthFetcher(ctx, options.ce ?? awsCeCli(ctx), nowMs, ceRequests)
          : exportMonthFetcher(ctx, options.cli ?? awsBillingCli(ctx, extra), exportAt, nowMs);
      const run = await runCostAccounts(prev, accounts, nowMs, fetchMonth);
      if (viaCostExplorer) {
        ctx.logger.info(
          { serviceId: AWS_BILLING_SERVICE_ID, ceRequests: ceRequests.requests },
          "aws_billing sync: Cost Explorer requests this run (each is billed USD 0.01)",
        );
      }
      return syncPassCursorSuccess(
        t0,
        run.bytes,
        encodeCostSyncCursor(PREFIX, run.cursor),
        run.lines,
      );
    },
  };
}
