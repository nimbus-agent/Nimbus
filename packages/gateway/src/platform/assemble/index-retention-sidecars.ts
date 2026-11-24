import type { Database } from "bun:sqlite";
import { loadNimbusIndexFromConfigDir } from "../../config/index-toml.ts";
import { loadNimbusOrchestrationFromConfigDir } from "../../config/orchestration-toml.ts";
import { startItemHistoryRetention } from "../../index/item-history-retention.ts";
import { startOrchestrationRunRetention } from "../../index/orchestration-run-retention.ts";
import type { PlatformPaths } from "../paths.ts";

/**
 * The daily prunes of the local index's own tables and rows, each reading its config on every tick so an edit
 * applies without a restart, each a batched pass that yields and never runs inside a sync:
 *   - `item_history` (Phase 10 IC1, `[index] history_retention_days`);
 *   - orchestration run rows `airflow:dag_run`, `dagster:job_run`, `prefect:flow_run`
 *     (`[orchestration] run_retention_days`; the DAG, job and deployment rows are never touched).
 */
export function startIndexRetentionSidecars(args: {
  readonly db: Database;
  readonly paths: PlatformPaths;
  readonly sidecarStops: Array<() => void>;
}): void {
  const { db, paths, sidecarStops } = args;
  const itemHistory = startItemHistoryRetention(db, {
    retentionDays: () => loadNimbusIndexFromConfigDir(paths.configDir).historyRetentionDays,
  });
  sidecarStops.push(() => itemHistory.stop());
  const runs = startOrchestrationRunRetention(db, {
    retentionDays: () => loadNimbusOrchestrationFromConfigDir(paths.configDir).runRetentionDays,
  });
  sidecarStops.push(() => runs.stop());
}
