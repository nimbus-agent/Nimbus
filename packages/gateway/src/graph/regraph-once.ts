import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { dbRun } from "../db/write.ts";
import type { ResolveServiceId } from "./graph-populator.ts";
import { regraphAllItems } from "./regraph.ts";

/** The `_meta` key the V96 migration inserts. Raw SQL on purpose: `ALLOWED_META_KEYS` guards IPC-reachable accessors. */
export const REGRAPH_PENDING_IC2_KEY = "regraph_pending_ic2";

/** The types whose anchors or edges IC2 changed, in the order they are re-grafted. */
export const IC2_REGRAPH_TYPES: readonly string[] = Object.freeze([
  "deployment",
  "incident",
  "error_issue",
  "data_quality_test",
]);

export type RegraphOnceOptions = {
  /**
   * Builds the service resolver from the STRICT config loader and THROWS when the config is unreadable. The
   * graph layer cannot import `metrics/` or the config loader, so the caller supplies this. A regraph with no
   * resolver would clear and not re-emit resolver-bound edges, so a throw leaves the marker and does nothing.
   */
  buildResolver: () => ResolveServiceId;
  logger?: Logger;
};

export type RegraphOnceResult =
  | { ran: false; reason: "no_marker" | "config_unreadable" }
  | { ran: true; cleared: boolean };

function markerPresent(db: Database): boolean {
  return db.query("SELECT 1 AS one FROM _meta WHERE key = ?").get(REGRAPH_PENDING_IC2_KEY) !== null;
}

/**
 * The one-shot re-graph after the V96 upgrade (Phase 10 IC2). A migration is SQL and cannot build the
 * resolver, so it leaves a marker; the gateway calls this once at boot. It re-grafts deployments
 * (never graphed when annotated), incidents, error issues and data-quality tests, one slice at a time with
 * a yield between slices, and deletes the marker only when no slice threw. A per-row failure is counted in
 * `skipped` and logged by `regraphAllItems`; it does not keep the marker. Idempotent.
 */
export async function runPendingRegraph(
  db: Database,
  opts: RegraphOnceOptions,
): Promise<RegraphOnceResult> {
  if (!markerPresent(db)) return { ran: false, reason: "no_marker" };
  let resolveServiceId: ResolveServiceId;
  try {
    resolveServiceId = opts.buildResolver();
  } catch (err) {
    opts.logger?.warn(
      { err },
      "regraph (IC2): service config unreadable; marker kept, nothing re-grafted",
    );
    return { ran: false, reason: "config_unreadable" };
  }
  let failed = false;
  for (const type of IC2_REGRAPH_TYPES) {
    try {
      const out = regraphAllItems(db, {
        types: [type],
        resolveServiceId,
        ...(opts.logger === undefined ? {} : { logger: opts.logger }),
      });
      opts.logger?.info({ type, ...out }, "regraph (IC2) slice done");
    } catch (err) {
      failed = true;
      opts.logger?.warn({ err, type }, "regraph (IC2) slice failed; marker kept");
    }
    await Bun.sleep(0);
  }
  if (failed) return { ran: true, cleared: false };
  dbRun(db, "DELETE FROM _meta WHERE key = ?", [REGRAPH_PENDING_IC2_KEY]);
  return { ran: true, cleared: true };
}
