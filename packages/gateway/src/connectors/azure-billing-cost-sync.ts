// Phase 7 (the Cost Pack, slice 12a; owner rulings 2026-11-28): Azure cost lines from a FOCUS CSV Cost Management
// export the owner created in Blob Storage (`[cost.azure] export = { account, container, path }`; nothing is read
// until that is set).
//
// A companion of `azure` (`azure_billing`): it reads the Vault's shared `azure.*` service principal through its
// grant, gets a bearer token over HTTPS (`_lib/azure-token.ts`; no `az` CLI) and reads the export with
// `azure-billing-export.ts`. The "account" of the month loop is the export location; the cost lines' billing
// account is the FOCUS `BillingAccountId`. The service principal needs the Storage Blob Data Reader role on the
// container. Per period and billing account the lines are written ONCE through `replaceCostLinesForMonth` (D24),
// and only the days the export covers are replaced (as `aws_billing` does). Slice 12b adds the Query API fallback.
import type { NimbusCostAzureConfig } from "../config/cost-azure-toml.ts";
import type { CostLine } from "../finops/cost-line.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  type AzureFetch,
  azureCredentialsFor,
  createAzureTokenSource,
} from "./_lib/azure-token.ts";
import {
  AZURE_BILLING_SOURCE,
  AZURE_COST_GAPS,
  AZURE_COST_PROVIDER,
  type AzureBlobClient,
  azureBlobClient,
  type ExportListing,
  listAzureExport,
  readAzureExportMonth,
} from "./azure-billing-export.ts";
import { type CostMonthOutcome, own, runCostAccounts } from "./cost-month-sync.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const AZURE_BILLING_SERVICE_ID = AZURE_BILLING_SOURCE;
const DAY_MS = 86_400_000;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.azure_billing;
/** The cursor key of a gap that belongs to the configuration, not to an export location. */
const CONFIG_KEY = "azure";

export type AzureBillingCostSyncableOptions = {
  /** `[cost.azure]`, read at every run; null when the cost config could not be read (the cursor is kept). */
  readonly azure: () => NimbusCostAzureConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: AzureFetch;
  readonly client?: AzureBlobClient;
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
function writeGroup(ctx: SyncContext, month: string, g: Group): CostMonthOutcome | null {
  const target = { provider: AZURE_COST_PROVIDER, billingAccountId: g.account, month };
  const covered = new Set(g.lines.map((l) => l.chargeDay));
  try {
    const kept = ctx.readOwnCostLinesForMonth(target).filter((l) => !covered.has(l.chargeDay));
    ctx.replaceCostLinesForMonth(target, [...kept, ...g.lines]);
  } catch (e) {
    ctx.logger.warn(
      {
        serviceId: AZURE_BILLING_SERVICE_ID,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "azure_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return null;
}

export function createAzureBillingCostSyncable(options: AzureBillingCostSyncableOptions): Syncable {
  return {
    serviceId: AZURE_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.azure();
      if (cfg === null) {
        const prev0 = { gaps: {}, synced: {}, pending: {} };
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0), 0);
      }
      const exportAt = cfg.export;
      const where =
        exportAt === null
          ? null
          : `azure://${exportAt.account}/${exportAt.container}/${exportAt.path}`;
      const accounts = where === null ? [] : [where];
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
      if (exportAt === null) {
        return idle({
          [CONFIG_KEY]:
            cfg.scopes.length > 0 ? AZURE_COST_GAPS.scopesOnly : AZURE_COST_GAPS.notConfigured,
        });
      }
      const creds = await azureCredentialsFor(ctx);
      // No credentials: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (creds === null) return idle(keep(prev.gaps));
      // One token per run (held in memory only), shared by every request of it.
      const client =
        options.client ??
        azureBlobClient(
          ctx,
          exportAt.account,
          exportAt.container,
          createAzureTokenSource(creds, options.fetch ?? fetchSameOriginOnly),
          options.fetch ?? fetchSameOriginOnly,
        );
      const nowMs = (options.now ?? Date.now)();
      let listing: Promise<ExportListing> | null = null;
      const listOnce = (): Promise<ExportListing> =>
        (listing ??= listAzureExport(client, exportAt.path));
      const run = await runCostAccounts(prev, accounts, nowMs, async (_account, month) => {
        const l = await listOnce();
        if (l.kind === "gap") return { kind: "gap", reason: l.reason };
        if (l.kind === "retry") return { kind: "retry" };
        const refs = l.periods.get(month);
        if (refs === undefined) {
          // A month the export has no folder for (it started later, or its first delivery is pending) is not a
          // gap, unless a folder that spans two months covers it: that one is not read, and the month says so.
          const span = l.spanning.get(month);
          return span === undefined
            ? { kind: "ok", lines: 0, bytes: 0 }
            : { kind: "month_gap", reason: AZURE_COST_GAPS.spans(span) };
        }
        const read = await readAzureExportMonth(client, exportAt.path, refs, month);
        if (!Array.isArray(read)) return read as CostMonthOutcome;
        // A charge day after today cannot be written (the intake refuses it): a stated gap, not an endless retry.
        const today = new Date(nowMs).toISOString().slice(0, 10);
        const future = read.filter((x) => x.chargeDay > today).length;
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
      });
      return syncPassCursorSuccess(
        t0,
        run.bytes,
        encodeCostSyncCursor(PREFIX, run.cursor),
        run.lines,
      );
    },
  };
}
