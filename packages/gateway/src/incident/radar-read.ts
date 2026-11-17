import type { Database } from "bun:sqlite";

import type { Expectation } from "../config/incident-predict-toml.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import type { LastEvent } from "./radar.ts";

/**
 * The radar's reads (Phase 10 IC8): the last matching event of each expectation kind, from the local index only
 * (D46(a): no network). `ci_success` scans the newest {@link CI_SCAN_CAP} `ci_run` items once per pass and binds
 * each to a service with the same identity resolver the DORA pipeline uses; when the cap is reached with no match
 * the answer is `unknown`, never "no successful run".
 */

export const CI_SCAN_CAP = 5000;

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function maxOf(row: unknown): number | null {
  const m = (row as { m: number | null } | null)?.m;
  return typeof m === "number" ? m : null;
}

/** Service id to the `modified_at` of its newest successful CI run, and whether the scan was cut by the cap. */
function newestCiSuccess(
  db: Database,
  configs: ReadonlyMap<string, ServiceConfig>,
): { readonly byService: Map<string, number>; readonly capped: boolean } {
  const rows = db
    .query(
      `SELECT service, metadata, modified_at FROM item WHERE type = 'ci_run'
        ORDER BY modified_at DESC, id LIMIT ?`,
    )
    .all(CI_SCAN_CAP + 1) as { service: string; metadata: string | null; modified_at: number }[];
  const capped = rows.length > CI_SCAN_CAP;
  const resolve = buildServiceIdentityResolver(configs);
  const byService = new Map<string, number>();
  for (const r of rows.slice(0, CI_SCAN_CAP)) {
    const meta = parseMeta(r.metadata);
    // lane-census: scope=ci_run
    if (meta === null || meta["conclusion"] !== "success") continue;
    const res = resolve({ service: r.service, type: "ci_run", metadata: meta });
    if (res.kind !== "bound" || byService.has(res.serviceId)) continue;
    byService.set(res.serviceId, r.modified_at);
  }
  return { byService, capped };
}

/** A `lastEventOf` for {@link evaluateRadar} over one pass's reads. */
export function radarReader(
  db: Database,
  configs: ReadonlyMap<string, ServiceConfig>,
): (e: Expectation) => LastEvent {
  let ci: ReturnType<typeof newestCiSuccess> | undefined;
  return (e) => {
    switch (e.kind) {
      case "deploy":
        return {
          known: true,
          atMs: maxOf(
            db
              .query(
                `SELECT MAX(COALESCE(finished_at_ms, started_at_ms)) AS m FROM deployment_items
                  WHERE nimbus_service_id = ? AND conclusion = 'success'`,
              )
              .get(e.service),
          ),
        };
      case "ci_success": {
        ci ??= newestCiSuccess(db, configs);
        const at = ci.byService.get(e.service);
        if (at !== undefined) return { known: true, atMs: at };
        return ci.capped ? { known: false } : { known: true, atMs: null };
      }
      case "sync":
        return {
          known: true,
          atMs: maxOf(
            db
              .query(
                `SELECT MAX(started_at + duration_ms) AS m FROM sync_telemetry
                  WHERE service = ? AND error_msg IS NULL`,
              )
              .get(e.service),
          ),
        };
      case "item":
        return {
          known: true,
          atMs: maxOf(
            db
              .query("SELECT MAX(modified_at) AS m FROM item WHERE service = ? AND type = ?")
              .get(e.service, e.type),
          ),
        };
    }
  };
}
