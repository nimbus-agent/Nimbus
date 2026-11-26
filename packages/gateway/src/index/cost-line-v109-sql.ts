/**
 * V109 - cost lines (Phase 7, the Cost Pack, static D24 rule `cost-line-confined`).
 *
 * `cost_line`: one normalised, FOCUS-shaped DAILY cost line per (source, provider, billing account, billing
 * period, charge day, grain). The grain is the export's own row grouped by sub-account, service, region,
 * resource-or-sku, charge category, currency, tags and the CI/AI dimensions (`grain_hash`, SHA-256 of their
 * canonical JSON, computed by `finops/cost-line-store.ts`). Imported lines are never folded into `__other__`,
 * so a file's totals reconcile exactly with the stored rows.
 *
 * Not the `item` table and not the FTS or vector index: a cost line is never embedded and never full-text
 * searched. Re-import contract: per (source, provider, billing account, billing period) an import REPLACES
 * every stored line on exactly the charge days the file contains; the unique key makes a repeated identical
 * import a no-op. Amounts are stored per `currency` and never summed across currencies by any reader.
 *
 * `cost_import`: the import ledger, one row per ACCEPTED import (the import id is the file's content hash). An
 * import whose id is already here writes nothing, so replaying an older export never overwrites a later
 * restatement; `nimbus cost import --remove` deletes the import's lines AND its row, so it can be imported
 * again. The source erasures delete a source's rows with its lines; the retention prune keeps them (a pruned
 * export stays accepted, so a replay of it stays a no-op).
 *
 * NO foreign key and NO trigger. An owner erasure (`connector remove`, `nimbus data delete`, `nimbus cost
 * import --remove`) deletes rows through the store. Both tables are written ONLY by
 * `finops/cost-line-store.ts`.
 *
 * Backfill: none (the tables are new). Re-runnable (IF NOT EXISTS).
 */
export const COST_LINE_V109_SQL = [
  `CREATE TABLE IF NOT EXISTS cost_line (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  billing_account_id TEXT NOT NULL CHECK (length(billing_account_id) <= 256),
  billing_period TEXT NOT NULL CHECK (length(billing_period) = 7),
  charge_day TEXT NOT NULL CHECK (length(charge_day) = 10),
  sub_account_id TEXT,
  sub_account_name TEXT,
  service_name TEXT NOT NULL,
  service_category TEXT,
  region_id TEXT,
  resource_id TEXT,
  resource_name TEXT,
  sku_id TEXT,
  charge_category TEXT NOT NULL CHECK (charge_category IN ('usage','purchase','tax','credit','adjustment')),
  billed_cost REAL NOT NULL,
  effective_cost REAL,
  currency TEXT NOT NULL CHECK (length(currency) BETWEEN 1 AND 16),
  tags_json TEXT NOT NULL CHECK (length(tags_json) <= 16384),
  repo TEXT,
  workflow TEXT,
  model TEXT,
  import_id TEXT NOT NULL,
  grain_hash TEXT NOT NULL
)`,
  "CREATE UNIQUE INDEX IF NOT EXISTS cost_line_grain ON cost_line (source, provider, billing_account_id, billing_period, charge_day, grain_hash)",
  "CREATE INDEX IF NOT EXISTS cost_line_source_day ON cost_line (source, charge_day)",
  "CREATE INDEX IF NOT EXISTS cost_line_source_account_day ON cost_line (source, provider, sub_account_id, charge_day)",
  `CREATE TABLE IF NOT EXISTS cost_import (
  import_id TEXT PRIMARY KEY CHECK (length(import_id) BETWEEN 1 AND 64),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 64),
  provider TEXT NOT NULL CHECK (length(provider) <= 256),
  file_sha256 TEXT NOT NULL CHECK (length(file_sha256) = 64),
  imported_at INTEGER NOT NULL
)`,
];
