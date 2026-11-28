// Phase 7 (the Cost Pack, slice 13; owner ruling D6): GCP cost lines from the Cloud Billing export to BigQuery
// (the generally available standard or detailed export; a FOCUS export is a later roadmap row).
// `[cost.gcp] export_table` names the table; nothing is read until it is set.
//
// A companion of `gcp` (`gcp_billing`): it reads the Vault's shared `gcp.*` credentials through its grant, mints a
// token with `gcloud` (`connectors/_lib/gcp-auth.ts`) and runs one query per month read (`gcp-billing-query.ts`).
// The "account" of the month loop is the export table; the cost lines' billing account is the export's
// `billing_account_id`, so one table that holds two billing accounts writes each as its own account.
//
// Per (billing account, month) the lines are written ONCE through `replaceCostLinesForMonth` (D24): the query reads
// the whole month, so the month is replaced whole. A billing account the result does not list keeps its lines. An
// empty result never writes: when the table name carries its billing account (`..._v1_AAAAAA_BBBBBB_CCCCCC`) and
// that account already holds lines for the month it is a `month_gap` (export lag), otherwise it is simply empty.
import { chooseGcpExportTable, type NimbusCostGcpConfig } from "../config/cost-gcp-toml.ts";
import type { CostLine } from "../finops/cost-line.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import {
  GCP_BILLING_SOURCE,
  GCP_COST_PROVIDER,
  gcpBillingLines,
} from "../finops/gcp-billing-lines.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { type GcpAuth, gcloudPrintAccessToken, resolveGcpAuth } from "./_lib/gcp-auth.ts";
import { aiCostEndDay } from "./ai-cost-sync.ts";
import { type CostMonthOutcome, own, runCostAccounts } from "./cost-month-sync.ts";
import {
  GCP_COST_GAPS,
  type GcpBqDeps,
  type GcpFail,
  type GcpPartition,
  readTablePartition,
  runBillingQuery,
} from "./gcp-billing-query.ts";
import { failedScanOutcome, nextScanDay, scanDue } from "./gcp-billing-rescan.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const GCP_BILLING_SERVICE_ID = GCP_BILLING_SOURCE;
const DAY_MS = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.gcp_billing;
/** The cursor key of a gap that belongs to the configuration, not to an export table. */
const CONFIG_KEY = "gcp";
/** `gcp_billing_export_v1_AAAAAA_BBBBBB_CCCCCC` and the detailed `..._resource_v1_...`: the billing account. */
const TABLE_ACCOUNT_RE = /^gcp_billing_export(?:_resource)?_v1_([0-9A-Za-z]+(?:_[0-9A-Za-z]+){2})$/;

export type GcpBillingCostSyncableOptions = {
  /** `[cost.gcp]`, read at every run; null when the cost config could not be read (the cursor is kept whole). */
  readonly gcp: () => NimbusCostGcpConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: typeof fetchSameOriginOnly;
  readonly mintAccessToken?: (auth: GcpAuth) => Promise<string | null>;
};

/** The billing account an export table's name carries, or null for a table named any other way. */
export function billingAccountOfTable(table: string): string | null {
  const m = TABLE_ACCOUNT_RE.exec(table.split(".")[2] ?? "");
  return m === null ? null : (m[1] as string).replaceAll("_", "-");
}

function byBillingAccount(lines: readonly CostLine[]): Map<string, CostLine[]> {
  const m = new Map<string, CostLine[]>();
  for (const l of lines) {
    const held = m.get(l.billingAccountId);
    if (held === undefined) m.set(l.billingAccountId, [l]);
    else held.push(l);
  }
  return m;
}

/** One billing account's month, replaced whole; null when written, else the outcome that stops the month. */
function writeAccount(
  ctx: SyncContext,
  month: string,
  account: string,
  lines: CostLine[],
): CostMonthOutcome | null {
  try {
    ctx.replaceCostLinesForMonth(
      { provider: GCP_COST_PROVIDER, billingAccountId: account, month },
      lines,
    );
  } catch (e) {
    ctx.logger.warn(
      { serviceId: GCP_BILLING_SERVICE_ID, month, err: e instanceof Error ? e.message : String(e) },
      "gcp_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return null;
}

function emptyMonth(ctx: SyncContext, table: string, month: string): CostMonthOutcome {
  const account = billingAccountOfTable(table);
  const held =
    account === null
      ? []
      : ctx.readOwnCostLinesForMonth({
          provider: GCP_COST_PROVIDER,
          billingAccountId: account,
          month,
        });
  if (held.length === 0) return { kind: "ok", lines: 0, bytes: 0 };
  return {
    kind: "month_gap",
    reason: `the export returned no rows for ${month}, which already holds lines (the export can lag); that month was not updated`,
  };
}

/** The cursor's `failedScan` member for one table (absent when it holds nothing). */
function withFailedScan(
  months: Readonly<Record<string, string>>,
  table: string | null,
): { failedScan?: Record<string, Record<string, string>> } {
  return table !== null && Object.keys(months).length > 0
    ? { failedScan: { [table]: { ...months } } }
    : {};
}

export function createGcpBillingCostSyncable(options: GcpBillingCostSyncableOptions): Syncable {
  return {
    serviceId: GCP_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.gcp();
      if (cfg === null) {
        const empty = { gaps: {}, synced: {}, pending: {} };
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, empty), 0);
      }
      const table = chooseGcpExportTable(cfg.exportTables);
      const accounts = table === null ? [] : [table];
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
            ...withFailedScan(table === null ? {} : (prev.failedScan?.[table] ?? {}), table),
          }),
          0,
        );
      if (table === null) return idle({ [CONFIG_KEY]: GCP_COST_GAPS.notConfigured });
      const auth = resolveGcpAuth(
        await ctx.getSharedSecret("gcp", "credentials_json_path"),
        await ctx.getSharedSecret("gcp", "auth_source"),
      );
      // No usable credentials: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (auth === null) return idle(keep(prev.gaps));
      const project = (await ctx.getSharedSecret("gcp", "project_id"))?.trim() ?? "";
      if (project === "") return idle({ [table]: GCP_COST_GAPS.noProject });
      const token = await (options.mintAccessToken ?? gcloudPrintAccessToken)(auth);
      if (token === null) {
        ctx.logger.warn(
          { serviceId: GCP_BILLING_SERVICE_ID },
          "gcp_billing sync: gcloud token mint failed",
        );
        return idle(keep(prev.gaps));
      }
      const deps: GcpBqDeps = { fetch: options.fetch ?? fetchSameOriginOnly, token };
      const nowMs = (options.now ?? Date.now)();
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const failedScan: Record<string, string> = { ...own(prev.failedScan ?? {}, table) };
      let partition: Promise<{ kind: "ok"; partition: GcpPartition } | GcpFail> | null = null;
      const partitionOnce = () => (partition ??= readTablePartition(ctx, deps, table));
      const scanned = (r: GcpFail, month: string): GcpFail => {
        failedScan[month] = today;
        return failedScanOutcome(r, month);
      };
      const run = await runCostAccounts(prev, accounts, nowMs, async (_account, month) => {
        const failedDay = own(failedScan, month);
        if (!scanDue(failedDay, month, today)) {
          return {
            kind: "month_gap",
            reason: `the ${month} billing scan failed on ${failedDay as string}; the next billed scan runs on ${nextScanDay(failedDay as string, month, today)}`,
          };
        }
        const p = await partitionOnce();
        if (p.kind !== "ok") return p;
        const q = await runBillingQuery(ctx, deps, {
          project,
          table,
          partition: p.partition,
          start: `${month}-01`,
          end: aiCostEndDay(month, nowMs),
          maxBytesBilled: cfg.maxBytesBilled,
        });
        if (q.kind !== "ok") return q.scanned === true ? scanned(q, month) : q;
        const mapped = gcpBillingLines(q.rows, month);
        if (mapped.unreadable > 0) {
          return scanned(
            {
              kind: "month_gap",
              reason: `${String(mapped.unreadable)} ${mapped.unreadable === 1 ? "row" : "rows"} of the ${month} billing export could not be read; that month was not updated`,
            },
            month,
          );
        }
        if (mapped.lines.length === 0) {
          const empty = emptyMonth(ctx, table, month);
          if (empty.kind === "month_gap") return scanned(empty, month);
          delete failedScan[month];
          return empty;
        }
        let written = 0;
        for (const [account, lines] of byBillingAccount(mapped.lines)) {
          const refused = writeAccount(ctx, month, account, lines);
          if (refused !== null) return refused;
          written += lines.length;
        }
        delete failedScan[month];
        return { kind: "ok", lines: written, bytes: 0 };
      });
      return syncPassCursorSuccess(
        t0,
        run.bytes,
        encodeCostSyncCursor(PREFIX, { ...run.cursor, ...withFailedScan(failedScan, table) }),
        run.lines,
      );
    },
  };
}
