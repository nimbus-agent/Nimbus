/**
 * `[cost.gcp]` - the GCP cost source (Phase 7, the Cost Pack, slice 13; owner ruling D6: the generally available
 * standard or detailed Cloud Billing export to BigQuery; the FOCUS export is a later roadmap row). Read by
 * `cost-toml.ts`, which refuses the whole cost config on any error here, as it does for every cost section.
 *
 * ```toml
 * [cost.gcp]
 * export_table = "my-project.billing.gcp_billing_export_resource_v1_01AB23_CD45EF_6789AB"   # or a list of two
 * max_bytes_billed = 53687091200                                                          # default 50 GiB
 * ```
 *
 * The table name is interpolated into the SQL, so it must match `project.dataset.table` over a closed alphabet.
 * Nothing is read until `export_table` is set.
 */

export interface NimbusCostGcpConfig {
  /** The tables named, in the order written (one or two). Empty: no export is configured. */
  readonly exportTables: readonly string[];
  /** The BigQuery `maximumBytesBilled` of every query: a query that would scan more fails and bills nothing. */
  readonly maxBytesBilled: number;
}

export const COST_GCP_DEFAULT_MAX_BYTES = 53_687_091_200;
export const COST_GCP_MIN_MAX_BYTES = 1_073_741_824;
export const COST_GCP_MAX_MAX_BYTES = 10_995_116_277_760;
export const COST_GCP_MAX_TABLES = 2;

export const DEFAULT_COST_GCP_CONFIG: NimbusCostGcpConfig = Object.freeze({
  exportTables: Object.freeze([]) as readonly string[],
  maxBytesBilled: COST_GCP_DEFAULT_MAX_BYTES,
});

export class CostGcpConfigError extends Error {}

/** `project.dataset.table`: the characters a BigQuery project, dataset and table name can take here. */
export const GCP_EXPORT_TABLE_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;
const DETAILED_PREFIX = "gcp_billing_export_resource_v1_";

/** The table the sync reads: the detailed export when one is named, otherwise the first. Null when none. */
export function chooseGcpExportTable(tables: readonly string[]): string | null {
  const detailed = tables.find((t) => (t.split(".")[2] ?? "").startsWith(DETAILED_PREFIX));
  return detailed ?? tables[0] ?? null;
}

function readTables(v: unknown): readonly string[] {
  if (v === undefined) return Object.freeze([]);
  const list: unknown[] = Array.isArray(v) ? v : [v];
  if (list.length === 0 || list.length > COST_GCP_MAX_TABLES) {
    throw new CostGcpConfigError(
      "[cost.gcp].export_table: name one table, or two (the detailed and the standard export)",
    );
  }
  const seen = new Set<string>();
  for (const t of list) {
    if (typeof t !== "string" || !GCP_EXPORT_TABLE_RE.test(t)) {
      throw new CostGcpConfigError(
        `[cost.gcp].export_table: ${JSON.stringify(t)?.slice(0, 80) ?? "undefined"} is not a "project.dataset.table" name`,
      );
    }
    if (seen.has(t)) throw new CostGcpConfigError(`[cost.gcp].export_table: ${t} is listed twice`);
    seen.add(t);
  }
  return Object.freeze([...(list as string[])]);
}

export function readCostGcpTable(t: Record<string, unknown>): NimbusCostGcpConfig {
  for (const k of Object.keys(t)) {
    if (k !== "export_table" && k !== "max_bytes_billed") {
      throw new CostGcpConfigError(`[cost.gcp]: unknown key "${k}"`);
    }
  }
  const max = t["max_bytes_billed"] ?? COST_GCP_DEFAULT_MAX_BYTES;
  if (
    typeof max !== "number" ||
    !Number.isSafeInteger(max) ||
    max < COST_GCP_MIN_MAX_BYTES ||
    max > COST_GCP_MAX_MAX_BYTES
  ) {
    throw new CostGcpConfigError(
      `[cost.gcp].max_bytes_billed must be a whole number of bytes from ${String(COST_GCP_MIN_MAX_BYTES)} (1 GiB) to ${String(COST_GCP_MAX_MAX_BYTES)} (10 TiB)`,
    );
  }
  return Object.freeze({ exportTables: readTables(t["export_table"]), maxBytesBilled: max });
}
