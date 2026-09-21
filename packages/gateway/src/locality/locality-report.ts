import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import type { ListenerRegistry, ListenerReport } from "./listener-registry.ts";

/**
 * `locality.report` — `nimbus wow`'s locality panel: which listeners are open RIGHT NOW, a
 * per-service inventory of the local index, and the index's real on-disk footprint. The panel's
 * whole value is that every number on it is true, so this file must never under-report (e.g. by
 * ignoring the WAL file, which holds live pages under WAL journal mode — see
 * `platform/assemble.ts`'s `applyWritablePragmas`) or claim a listener is open when its probe says
 * otherwise.
 *
 * Pure over its deps: `db`/`dbPath`/`registry`/`nowMs`/`statSize` are all injected, so this module
 * never calls `Date.now()` or touches `processListeners` itself — the IPC handler
 * (`ipc/locality-rpc.ts`) is the only place those live calls happen.
 */

export interface LocalityReport {
  readonly listeners: readonly ListenerReport[];
  readonly inventory: readonly { readonly service: string; readonly items: number }[];
  readonly db: { readonly path: string; readonly bytes: number };
  readonly t1: number;
}

/** Default `statSize`: `statSync` in a try/catch, `null` on any error (ENOENT included). */
function defaultStatSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/**
 * `path` main file + `-wal` + `-shm`, each counted only if it exists. WAL mode (which
 * `openGatewaySqlite` turns on for every real gateway) keeps live pages in the `-wal` file, not
 * the main one, so summing only the main file would under-report a database that just got busier.
 */
function dbBytes(path: string, statSize: (p: string) => number | null): number {
  if (path === ":memory:") return 0;
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    const size = statSize(`${path}${suffix}`);
    if (size !== null) total += size;
  }
  return total;
}

/**
 * Not built over `collectIndexMetrics` (`db/metrics.ts`): that function's `SELECT service,
 * COUNT(*) AS c FROM item GROUP BY service` is the same query, but it comes bundled with
 * unrelated queries (embedding coverage, per-connector sync times, latency percentiles, PR file
 * coverage) this report has no use for, and it returns an unordered `Record<string, number>`
 * rather than the sorted array this report needs — reshaping that output would cost as much as
 * this direct query, without the extra work `collectIndexMetrics` does on every call.
 * `db/index-health.ts`'s per-service query does not fit either: it JOINs against embedding
 * coverage and carries an extra column, so it is not "per-service item counts with no extra
 * filtering."
 */
function collectInventory(db: Database): Array<{ service: string; items: number }> {
  const rows = db
    .query(
      "SELECT service, COUNT(*) AS items FROM item GROUP BY service ORDER BY items DESC, service ASC",
    )
    .all() as Array<{ service: string; items: number }>;
  return rows.map((r) => ({ service: r.service, items: r.items }));
}

export function buildLocalityReport(deps: {
  db: Database;
  dbPath: string;
  registry: ListenerRegistry;
  nowMs: number;
  /** null on ENOENT; injectable for tests. Defaults to a try/catch'd `statSync`. */
  statSize?: (p: string) => number | null;
}): LocalityReport {
  const statSize = deps.statSize ?? defaultStatSize;
  return {
    listeners: deps.registry.live(),
    inventory: collectInventory(deps.db),
    db: { path: deps.dbPath, bytes: dbBytes(deps.dbPath, statSize) },
    t1: deps.nowMs,
  };
}
