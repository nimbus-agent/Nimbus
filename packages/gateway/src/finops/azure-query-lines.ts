// Phase 7 (the Cost Pack, slice 12b): the Azure Cost Management Query API's rows as cost lines. Pure (static D48:
// no network, no connector, no model import).
//
// Response shape (https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage): `properties.columns`
// is `[{ name, type }]` and every row of `properties.rows` is an array in that column order. Columns are mapped BY
// NAME, never by position: the service decides the order. The request names the aggregation `Cost` and groups by
// `ServiceName` and `ResourceGroupName`; daily granularity adds `UsageDate` (a number such as 20261103) and the
// service adds `Currency`.
//
// A missing required column (the currency one included) is a RETRY, never a guess. A row that cannot be read is
// DROPPED and counted: the sync turns any drop into a month gap, so a partial month is never written. Rows of one
// day and grain are summed (the `cost_line_grain` unique index).
import { type CostLine, costLineGrainHash } from "./cost-line.ts";

export const AZURE_QUERY_SOURCE = "azure_billing";
export const AZURE_QUERY_PROVIDER = "azure";
/** A row with no service name (Azure leaves it empty for some charges). */
export const AZURE_UNSPECIFIED_SERVICE = "unspecified";
const MAX_TEXT = 256;

export interface AzureQueryPage {
  readonly columns: readonly unknown[];
  readonly rows: readonly unknown[];
}

export type AzureQueryMapResult =
  | {
      readonly kind: "lines";
      readonly lines: readonly CostLine[];
      readonly rows: number;
      readonly dropped: { readonly malformed: number; readonly outside_month: number };
    }
  | { readonly kind: "retry"; readonly missing: readonly string[] };

type Columns = {
  readonly cost: number;
  readonly date: number;
  readonly service: number;
  readonly currency: number;
  /** -1: the response has no resource-group column (a billing-account scope may omit it). */
  readonly group: number;
};

function columnIndexes(columns: readonly unknown[]): Columns | readonly string[] {
  const at = (name: string, alt?: string): number =>
    columns.findIndex((c) => {
      const n = typeof c === "object" && c !== null ? (c as Record<string, unknown>)["name"] : null;
      return typeof n === "string" && (n === name || n === alt);
    });
  const found = {
    cost: at("Cost", "PreTaxCost"),
    date: at("UsageDate"),
    service: at("ServiceName"),
    currency: at("Currency"),
    group: at("ResourceGroupName", "ResourceGroup"),
  };
  const missing = (
    [
      ["Cost", found.cost],
      ["UsageDate", found.date],
      ["ServiceName", found.service],
      ["Currency", found.currency],
    ] as const
  )
    .filter(([, i]) => i < 0)
    .map(([n]) => n);
  return missing.length > 0 ? missing : found;
}

/** The UTC day of a `UsageDate` cell: 20261103, "20261103" or an ISO date; otherwise null. */
export function usageDay(v: unknown): string | null {
  const t = typeof v === "number" && Number.isInteger(v) ? String(v) : v;
  if (typeof t !== "string") return null;
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:$|T)/.exec(t);
  if (m === null) return null;
  const day = `${m[1] ?? ""}-${m[2] ?? ""}-${m[3] ?? ""}`;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day ? null : day;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v.length <= MAX_TEXT ? v : null;

export interface AzureQueryScope {
  /** The scope as the request path has it (no leading or trailing slash); it is also the billing account id. */
  readonly scope: string;
  readonly month: string;
  /** Charge days after this (`YYYY-MM-DD`) are not kept (the intake refuses a future day). */
  readonly lastDay: string;
}

function lineOf(
  w: AzureQueryScope,
  cols: Columns,
  day: string,
  row: readonly unknown[],
): CostLine | null {
  const cost = row[cols.cost];
  const currency = text(row[cols.currency]);
  const service = text(row[cols.service]);
  const rawGroup = cols.group < 0 ? "" : text(row[cols.group]);
  if (
    typeof cost !== "number" ||
    !Number.isFinite(cost) ||
    currency === null ||
    currency === "" ||
    service === null ||
    rawGroup === null
  ) {
    return null;
  }
  const group = rawGroup === "" ? null : rawGroup;
  return {
    source: AZURE_QUERY_SOURCE,
    provider: AZURE_QUERY_PROVIDER,
    billingAccountId: w.scope,
    billingPeriod: w.month,
    chargeDay: day,
    // A resource group name is case-insensitive in Azure and the service has returned both cases: the id is
    // lower-cased, the name keeps what the API said.
    subAccountId: group === null ? null : group.toLowerCase(),
    subAccountName: group,
    serviceName: service === "" ? AZURE_UNSPECIFIED_SERVICE : service,
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: null,
    chargeCategory: cost < 0 ? "credit" : "usage",
    billedCost: cost,
    effectiveCost: cost,
    currency: currency.toUpperCase(),
    tags: {},
    repo: null,
    workflow: null,
    model: null,
    importId: `${AZURE_QUERY_SOURCE}:${w.scope}:${w.month}`,
  };
}

/** Every page of one scope's month as cost lines (or the columns that make the read a retry). */
export function azureQueryLines(
  w: AzureQueryScope,
  pages: readonly AzureQueryPage[],
): AzureQueryMapResult {
  const dropped = { malformed: 0, outside_month: 0 };
  const merged = new Map<string, CostLine>();
  let rows = 0;
  for (const page of pages) {
    const cols = columnIndexes(page.columns);
    if (Array.isArray(cols)) return { kind: "retry", missing: cols as readonly string[] };
    for (const r of page.rows) {
      rows++;
      const row = Array.isArray(r) ? (r as readonly unknown[]) : null;
      const day = row === null ? null : usageDay(row[(cols as Columns).date]);
      if (row === null || day === null) {
        dropped.malformed++;
        continue;
      }
      if (day.slice(0, 7) !== w.month || day > w.lastDay) {
        dropped.outside_month++;
        continue;
      }
      const line = lineOf(w, cols as Columns, day, row);
      if (line === null) {
        dropped.malformed++;
        continue;
      }
      const key = `${day}|${costLineGrainHash(line)}`;
      const prior = merged.get(key);
      merged.set(
        key,
        prior === undefined
          ? line
          : {
              ...prior,
              billedCost: prior.billedCost + line.billedCost,
              effectiveCost: (prior.effectiveCost ?? 0) + (line.effectiveCost ?? 0),
            },
      );
    }
  }
  return { kind: "lines", lines: [...merged.values()], rows, dropped };
}
