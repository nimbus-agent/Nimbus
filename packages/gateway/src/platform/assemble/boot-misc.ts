import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { startAuditShipper } from "../../audit/audit-shipper.ts";
import { reconcileOrphanedSessions } from "../../computer-use/cu-boot-reconcile.ts";
import { loadNimbusMcpSinkFromConfigDir } from "../../config/mcp-sink-toml.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../../config/nimbus-toml.ts";
import { appendBootMarker } from "../../egress/egress-boot-marker.ts";
import type { CoverageVector } from "../../egress/egress-coverage.ts";
import { runPendingRegraph } from "../../graph/regraph-once.ts";
import { reconcileActionsAtBoot } from "../../mcp-sink/capture-act.ts";
import { CaptureStore, FINISHED_RETENTION_MS } from "../../mcp-sink/capture-store.ts";
import { buildServiceIdentityResolver } from "../../metrics/service-identity.ts";

/**
 * M-1: `loadNimbusServiceConfigsFromConfigDir` throws on any malformed
 * `[metrics.dora.*]`/`[ci.service.*]` block (missing `repos`, unknown key, bad
 * URN/regex, out-of-range window, invalid env name). Degrade to no service-identity
 * bindings (timeline correlation falls back to plain `metadata.service`, as before
 * this feature existed) rather than aborting gateway startup over a config typo.
 */
export function loadServiceConfigsOrDegrade(
  configDir: string,
  logger: Logger,
): ReturnType<typeof loadNimbusServiceConfigsFromConfigDir> {
  try {
    return loadNimbusServiceConfigsFromConfigDir(configDir);
  } catch (err) {
    logger.warn(
      { err },
      "failed to load [metrics.dora.*]/[ci.service.*] service configs — timeline " +
        "correlation will fall back to metadata.service only until this is fixed",
    );
    return new Map();
  }
}

/**
 * I29: append this process's boot marker WITHOUT letting a failure abort gateway startup.
 *
 * `appendEgressEntry` (via `readHeadHash`) deliberately THROWS when the ledger's head `row_hash`
 * is malformed — fail-closed against a corrupted chain — and a read-only/locked SQLite file
 * throws too. Left unguarded, either condition would take the WHOLE GATEWAY down over what is, by
 * design, a DEGRADED-PROOF condition rather than a fatal one: a window with no covering boot
 * marker already reports `indeterminate` instead of a false zero (see `egress-boot-marker.ts` /
 * `coverageForWindow`). Worse, `egress.verify` / `nimbus egress verify` are reachable only
 * through a running gateway, so aborting boot here would prevent the user from even diagnosing
 * the corruption that is blocking it.
 *
 * Swallowing the failure must never be SILENT: log a warning naming what failed and stating that
 * egress proofs will read `indeterminate` until the next successful boot marker.
 */
export function appendBootMarkerOrWarn(
  db: Database,
  coverage: CoverageVector,
  now: number,
  logger: Pick<Logger, "warn">,
): void {
  try {
    appendBootMarker(db, coverage, now);
  } catch (err) {
    logger.warn(
      { err },
      "I29: failed to append the egress boot marker — egress proofs (nimbus prove / " +
        "egress.verify) will report 'indeterminate' for every window this process observes " +
        "until the next successful boot marker",
    );
  }
}

/**
 * Audit shipper (Task 19, I22): when policy configures an org SIEM endpoint
 * (`enforced().auditShipTo`), ship audit_log entries there as metadata-only
 * NDJSON — NEVER `action_json` (the no-leak guarantee; the SELECT omits it).
 * Forward-only: the shipper baselines on the current MAX(id) at start and
 * ships only entries created afterwards, so no persisted-cursor migration is
 * needed. Must be called after the policy gate is built, so the caller passes
 * the already-enforced value rather than the gate.
 *
 * Extracted from `assemblePlatformServices` to keep that function's cognitive
 * complexity in budget (S3776); the guard is the same one it inlined.
 */
export function maybeStartAuditShipper(
  db: Database,
  auditShipTo: string | undefined,
  sidecarStops: Array<() => void>,
): void {
  if (auditShipTo === undefined || auditShipTo.length === 0) {
    return;
  }
  const auditShipper = startAuditShipper(db, { shipTo: auditShipTo });
  sidecarStops.push(() => auditShipper.stop());
}

/**
 * Close the `cu_session` rows orphaned by a previous gateway process (I35, `cu-boot-reconcile.ts`).
 *
 * Best-effort, matching `appendBootMarkerOrWarn`: a bookkeeping failure must not abort gateway
 * startup, and staying SILENT about it is what would make it a bug rather than an event.
 */
export function reconcileOrphanedCuSessionsOrWarn(db: Database, logger: Logger): void {
  try {
    const reconciled = reconcileOrphanedSessions(db, { now: () => Date.now() });
    if (reconciled.reconciled > 0) {
      logger.info(
        { sessions: reconciled.reconciled },
        "computer-use: closed sessions orphaned by a previous gateway process",
      );
    }
  } catch (e) {
    logger.warn(
      { err: e instanceof Error ? e.message : String(e) },
      "computer-use: could not reconcile orphaned sessions; `nimbus computer sessions` may show a stale open session",
    );
  }
}

/**
 * Assign an optional value onto `target[key]` only when it is present.
 *
 * Under `exactOptionalPropertyTypes` an explicit `undefined` is a DIFFERENT type from an absent
 * key, so these cannot be plain assignments — and a run of `if (x !== undefined)` lines was a
 * measurable share of the assembler's cognitive-complexity score, for the same reason `pushStops`
 * below exists.
 */
export function assignIfPresent<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

/**
 * Register `stop()` for each refresher that is present.
 *
 * Deliberately takes the refreshers rather than pre-built closures: a caller
 * building `() => x.stop()` for an `x` that turned out to be `undefined` would
 * only fail at shutdown, long after the mistake.
 */
export function pushStops(
  sidecarStops: Array<() => void>,
  refreshers: ReadonlyArray<{ stop: () => void } | undefined>,
): void {
  for (const r of refreshers) {
    if (r !== undefined) {
      sidecarStops.push(() => r.stop());
    }
  }
}

/**
 * The MCP capture sink's boot half (I28): load `[mcp_sink]` (an invalid section is logged and the
 * sink stays OFF), then — BEFORE the IPC server accepts a connection (spec § 9) — expire due
 * proposals and fail any action a restart interrupted mid-consent, then apply retention.
 */
export function bootCaptureStore(
  db: Database,
  configDir: string,
  logger: Logger,
): { mcpSinkLoad: ReturnType<typeof loadNimbusMcpSinkFromConfigDir>; captureStore: CaptureStore } {
  const mcpSinkLoad = loadNimbusMcpSinkFromConfigDir(configDir);
  if (!mcpSinkLoad.ok) {
    logger.error(
      { event: "mcp_sink.config_invalid", error: mcpSinkLoad.error },
      "[mcp_sink] is invalid; the capture sink is OFF",
    );
  }
  const captureStore = new CaptureStore(db);
  // I28 act door: expire due proposals and fail any action a restart interrupted mid-consent,
  // BEFORE the IPC server accepts a connection (spec § 9). Then retention, as before.
  const actBoot = reconcileActionsAtBoot({ db, store: captureStore }, Date.now());
  if (actBoot.expired + actBoot.interrupted > 0) {
    logger.info({ event: "mcp_sink.act_reconcile", ...actBoot }, "act door boot reconcile");
  }
  captureStore.pruneFinished(Date.now() - FINISHED_RETENTION_MS);
  return { mcpSinkLoad, captureStore };
}

/**
 * The one-shot re-graph after the V96 upgrade (Phase 10 IC2): deployments, incidents, error issues and
 * data-quality tests get their corrected anchors and edges. Fire-and-forget with a caught rejection; a
 * shutdown mid-run simply leaves the marker for the next boot. The resolver comes from the STRICT config
 * loader (a malformed config keeps the marker rather than re-grafting without it); `graph/` cannot import
 * the loader, so the builder is supplied here.
 */
export function startPendingRegraph(
  db: Database,
  configDir: string,
  logger: Logger,
  sidecarStops: Array<() => void>,
): void {
  let stopped = false;
  sidecarStops.push(() => {
    stopped = true;
  });
  const buildResolver = (): ReturnType<typeof buildServiceIdentityResolver> =>
    buildServiceIdentityResolver(loadNimbusServiceConfigsFromConfigDir(configDir));
  queueMicrotask(() => {
    if (stopped) return;
    runPendingRegraph(db, { buildResolver, logger }).catch((err: unknown) => {
      logger.warn({ err }, "regraph (IC2) failed; marker kept");
    });
  });
}
