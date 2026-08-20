import type { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { listWatchers } from "../automation/watcher-store.ts";
import { getAllConnectorHealth } from "../connectors/health.ts";
import { asRecord } from "../connectors/unknown-record.ts";
import { listMigrationBackups } from "../db/backups-list.ts";
import { collectIndexMetrics } from "../db/metrics.ts";
import { runReadOnlySelect, SqlGuardError } from "../db/query-guard.ts";
import { formatRepairReport, repairIndex } from "../db/repair.ts";
import { listSnapshots, previewRestore, pruneSnapshots, takeSnapshot } from "../db/snapshot.ts";
import { formatVerifyResult, verifyIndex } from "../db/verify.ts";
import { preT2DisabledCount, signatureDisabledRegistry } from "../extensions/hard-disable.ts";
import { buildItemListSql } from "../index/item-list-query.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { LocalIndex as LocalIndexClass } from "../index/local-index.ts";
import {
  buildNoDownstreamIncidentSql,
  buildNotTouchingSql,
  countNoDownstreamIncidentExclusions,
  countNotTouchingExclusions,
  missingSubstrateRefusal,
  type NegationExplain,
  probeCorrelatesWith,
  probePrFileCoverage,
  toPositionalSubquery,
} from "../index/negation-predicates.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { buildTelemetryPreview } from "../telemetry/collector.ts";
import type { ConsentCoordinator } from "./consent.ts";

export class DiagnosticsRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.rpcCode = rpcCode;
    this.name = "DiagnosticsRpcError";
  }
}

export type DiagnosticsRpcContext = {
  readonly dataDir: string;
  readonly configDir: string;
  readonly localIndex?: LocalIndex;
  readonly consent: ConsentCoordinator;
  readonly gatewayVersion: string;
  readonly startedAtMs: number;
  readonly sandboxRunner?: SandboxRunner;
  readonly autoUpdateDiag?: {
    cachedUpdatesCount: () => number;
    intervalHours: number;
    airGapBlocked: boolean;
  };
};

export function buildSandboxDiagPayload(runner: SandboxRunner | undefined): {
  platform_capabilities: { network: "per_host" | "all_or_nothing"; reason: string | null };
  linux_helper: { available: boolean; reason: string | null } | null;
  stale_rules_count: number;
} {
  if (runner === undefined) {
    return {
      platform_capabilities: {
        network: "all_or_nothing",
        reason: "sandbox runner unavailable",
      },
      linux_helper: null,
      stale_rules_count: 0,
    };
  }
  const network: "per_host" | "all_or_nothing" = runner.isFullyActive()
    ? "per_host"
    : "all_or_nothing";
  const reason = runner.degradedReason();
  const linux_helper =
    runner.platform === "linux" ? { available: runner.isFullyActive(), reason } : null;
  return {
    platform_capabilities: { network, reason },
    linux_helper,
    stale_rules_count: 0,
  };
}

function requireLocalIndex(ctx: DiagnosticsRpcContext): LocalIndex {
  const li = ctx.localIndex;
  if (li === undefined) {
    throw new DiagnosticsRpcError(-32603, "Local index is not available");
  }
  return li;
}

function requireDb(ctx: DiagnosticsRpcContext): Database {
  return requireLocalIndex(ctx).getDatabase();
}

function serializeHealthSnapshot(
  s: import("../connectors/health.ts").ConnectorHealthSnapshot,
): Record<string, unknown> {
  const o: Record<string, unknown> = {
    connectorId: s.connectorId,
    state: s.state,
    backoffAttempt: s.backoffAttempt,
  };
  if (s.retryAfter !== undefined) {
    o["retryAfterMs"] = s.retryAfter.getTime();
  }
  if (s.backoffUntil !== undefined) {
    o["backoffUntilMs"] = s.backoffUntil.getTime();
  }
  if (s.lastError !== undefined) {
    o["lastError"] = s.lastError;
  }
  if (s.lastSuccessfulSync !== undefined) {
    o["lastSuccessfulSyncMs"] = s.lastSuccessfulSync.getTime();
  }
  if (s.lastSyncAttempt !== undefined) {
    o["lastSyncAttemptMs"] = s.lastSyncAttempt.getTime();
  }
  return o;
}

/**
 * The `index` payload for BOTH `index.metrics` and `diag.snapshot` — the two RPCs share this one
 * function, so a field is either on both or on neither.
 *
 * It is a HAND-BUILT allow-list, not a spread of `collectIndexMetrics()`. A field added to
 * `IndexMetrics` and not added here never crosses the IPC seam, and nothing fails: the gateway
 * struct test still passes, the CLI still compiles, and the consumer-side line simply never
 * renders. `prFileCoverage` shipped exactly that way. The guard is the seam test
 * "diag.snapshot carries prFileCoverage across the IPC seam" in `diagnostics-rpc.test.ts`, which
 * asserts on the value this function returns rather than on a hand-built payload.
 */
function serializeMetrics(db: Database): Record<string, unknown> {
  const m = collectIndexMetrics(db);
  const lastSync: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(m.lastSuccessfulSyncByConnector)) {
    lastSync[k] = v === null ? null : v.getTime();
  }
  return {
    itemCountByService: m.itemCountByService,
    totalItems: m.totalItems,
    indexSizeBytes: m.indexSizeBytes,
    bodyBytes: m.bodyBytes,
    ftsIndexBytes: m.ftsIndexBytes,
    embeddingCoveragePercent: m.embeddingCoveragePercent,
    lastSuccessfulSyncByConnector: lastSync,
    queryLatencyP50Ms: m.queryLatencyP50Ms,
    queryLatencyP95Ms: m.queryLatencyP95Ms,
    queryLatencyP99Ms: m.queryLatencyP99Ms,
    prFileCoverage: m.prFileCoverage,
  };
}

type DiagnosticsRpcOutcome = { kind: "hit"; value: unknown } | { kind: "miss" };

function rpcConfigValidate(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const p = join(ctx.configDir, "nimbus.toml");
  if (!existsSync(p)) {
    return {
      kind: "hit",
      value: { ok: false, errors: ["nimbus.toml not found"], warnings: [] },
    };
  }
  const raw = readFileSync(p, "utf8");
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!/\bschema_version\b\s*=\s*\d+/.test(raw)) {
    warnings.push(
      "schema_version = <integer> is recommended in nimbus.toml; missing key uses legacy defaults",
    );
  }
  return { kind: "hit", value: { ok: errors.length === 0, errors, warnings } };
}

function assertTelemetryDisablePathSafe(path: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink()) {
      throw new DiagnosticsRpcError(
        -32603,
        "Refusing to write telemetry marker: path is a symlink",
      );
    }
  } catch (e: unknown) {
    if (e instanceof DiagnosticsRpcError) {
      throw e;
    }
    if (e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      return;
    }
    throw e;
  }
}

function resolvedPathOrLogical(dir: string): string {
  const logical = resolve(dir);
  try {
    return realpathSync(logical);
  } catch {
    return logical;
  }
}

function isResolvedDirUnderOsTemp(candidate: string): boolean {
  const tmpRoot = resolvedPathOrLogical(tmpdir());
  const dir = resolvedPathOrLogical(candidate);
  if (dir === tmpRoot) {
    return true;
  }
  const rel = relative(tmpRoot, dir);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function rpcTelemetryDisableMark(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  if (isResolvedDirUnderOsTemp(ctx.dataDir)) {
    throw new DiagnosticsRpcError(
      -32603,
      "Refusing to write telemetry marker: data directory must not be under the OS temporary directory",
    );
  }
  const p = join(ctx.dataDir, ".nimbus-telemetry-disabled");
  assertTelemetryDisablePathSafe(p);
  writeFileSync(p, `${String(Date.now())}\n`, { mode: 0o600 });
  return { kind: "hit", value: { ok: true } };
}

function rpcDbVerify(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const r = verifyIndex(requireDb(ctx), LocalIndexClass.SCHEMA_VERSION);
  return {
    kind: "hit",
    value: {
      clean: r.clean,
      findings: r.findings,
      formatted: formatVerifyResult(r).output,
      exitCode: formatVerifyResult(r).exitCode,
    },
  };
}

function rpcDbRepair(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  const confirm = rec?.["confirm"] === true;
  if (!confirm) {
    throw new DiagnosticsRpcError(-32602, "Repair requires confirm: true (CLI: pass --yes)");
  }
  const report = repairIndex(requireDb(ctx), LocalIndexClass.SCHEMA_VERSION);
  return { kind: "hit", value: { report, formatted: formatRepairReport(report) } };
}

function rpcDbSnapshotTake(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const path = takeSnapshot(requireDb(ctx), ctx.dataDir);
  return { kind: "hit", value: { path } };
}

function rpcDbSnapshotsList(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const entries = listSnapshots(ctx.dataDir);
  return {
    kind: "hit",
    value: entries.map((e) => ({
      filename: e.filename,
      timestampMs: e.timestampMs,
      compressedSizeBytes: e.compressedSizeBytes,
      path: e.path,
    })),
  };
}

function rpcDbBackupsList(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  return { kind: "hit", value: listMigrationBackups(ctx.dataDir) };
}

function rpcDbSnapshotsPrune(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  if (rec?.["confirm"] !== true) {
    throw new DiagnosticsRpcError(-32602, "Prune requires confirm: true (CLI: pass --yes)");
  }
  const keepRaw = rec?.["keepLast"];
  const keepLast =
    typeof keepRaw === "number" && Number.isFinite(keepRaw)
      ? Math.min(100, Math.max(1, Math.floor(keepRaw)))
      : 7;
  const deleted = pruneSnapshots(ctx.dataDir, keepLast);
  return { kind: "hit", value: { deleted, keepLast } };
}

function rpcDbRestorePreview(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  const path = typeof rec?.["path"] === "string" ? rec["path"].trim() : "";
  if (path === "") {
    throw new DiagnosticsRpcError(-32602, "Missing path");
  }
  const preview = previewRestore(requireDb(ctx), path);
  return { kind: "hit", value: preview };
}

function rpcIndexMetrics(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  return { kind: "hit", value: serializeMetrics(requireDb(ctx)) };
}

function rpcDbGetMeta(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  const key = typeof rec?.["key"] === "string" ? rec["key"] : "";
  if (key === "") {
    throw new DiagnosticsRpcError(-32602, "Missing key");
  }
  try {
    return { kind: "hit", value: { value: requireLocalIndex(ctx).getMeta(key) } };
  } catch (e) {
    throw new DiagnosticsRpcError(-32602, e instanceof Error ? e.message : String(e));
  }
}

function rpcDbSetMeta(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  const key = typeof rec?.["key"] === "string" ? rec["key"] : "";
  const value = typeof rec?.["value"] === "string" ? rec["value"] : undefined;
  if (key === "" || value === undefined) {
    throw new DiagnosticsRpcError(-32602, "Missing key or value");
  }
  try {
    requireLocalIndex(ctx).setMeta(key, value);
    return { kind: "hit", value: { ok: true } };
  } catch (e) {
    throw new DiagnosticsRpcError(-32602, e instanceof Error ? e.message : String(e));
  }
}

// `QueryExplain` / `MissingSubstrateRefusal` / `missingSubstrateRefusal` / `toPositionalSubquery`
// used to be defined here, byte-identical to a second copy in `ipc/people-rpc.ts`. Hoisted into
// `index/negation-predicates.ts` (Task 4 fix round 1) as `NegationExplain` /
// `MissingSubstrateRefusal` / `missingSubstrateRefusal` / `toPositionalSubquery` — see that
// module's doc comments — and imported below rather than redefined, so the two IPC files cannot
// drift again the way this pair already had (the identical duplication was itself Minor-1 review
// feedback). `QueryExplain` stays as a local type ALIAS only so every existing reference in this
// file reads the same as before.
type QueryExplain = NegationExplain;

function rpcIndexQueryItems(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  const rawSinceMs = rec?.["sinceMs"];
  const sinceMs =
    typeof rawSinceMs === "number" && Number.isFinite(rawSinceMs)
      ? Math.floor(rawSinceMs)
      : undefined;
  const rawUntilMs = rec?.["untilMs"];
  const untilMs =
    typeof rawUntilMs === "number" && Number.isFinite(rawUntilMs)
      ? Math.floor(rawUntilMs)
      : undefined;
  const limitRaw = rec?.["limit"];
  const limit =
    typeof limitRaw === "number" && Number.isFinite(limitRaw)
      ? Math.min(1000, Math.max(1, Math.floor(limitRaw)))
      : 50;
  const services = Array.isArray(rec?.["services"])
    ? (rec["services"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const types = Array.isArray(rec?.["types"])
    ? (rec["types"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const rawNotTouching = rec?.["notTouching"];
  // A PRESENT but unusable `notTouching` must NEVER silently fall through to the plain path: that
  // would answer a different question ("every item") than the one asked ("items not touching X"),
  // which is exactly the confident-wrong-answer failure this whole feature exists to prevent.
  // Written as what MAY pass, not what may not, so a new unusable shape is rejected by default:
  // a blank string is reachable from the documented CLI surface (`takeFlag`,
  // cli/src/commands/serve.ts, returns `args[i + 1]` verbatim, so `--not-touching ''` arrives as
  // `""`), and a non-string reaches here only over raw JSON-RPC — a narrower door onto the same
  // failure, closed here because it costs one clause. `null` is treated as ABSENT, not as an
  // error: JSON-RPC callers routinely spell an omitted optional that way.
  if (rawNotTouching !== undefined && rawNotTouching !== null) {
    if (typeof rawNotTouching !== "string" || rawNotTouching.trim() === "") {
      throw new DiagnosticsRpcError(-32602, "notTouching must be a non-empty glob pattern");
    }
  }
  const notTouching = typeof rawNotTouching === "string" ? rawNotTouching : undefined;
  const rawNoDownstreamIncident = rec?.["noDownstreamIncident"];
  // Same reasoning, same failure: `noDownstreamIncident: "yes"` is a caller ASKING for the
  // negation, and `=== true` alone would hand them every deployment instead. `explain` gets no
  // such check on purpose — it is a debug flag, so falling back to off answers the same question.
  if (rawNoDownstreamIncident !== undefined && rawNoDownstreamIncident !== null) {
    if (typeof rawNoDownstreamIncident !== "boolean") {
      throw new DiagnosticsRpcError(-32602, "noDownstreamIncident must be a boolean");
    }
  }
  const noDownstreamIncident = rawNoDownstreamIncident === true;
  const explain = rec?.["explain"] === true;

  const baseParams = {
    services,
    types,
    limit,
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(untilMs === undefined ? {} : { untilMs }),
  };
  // The SAME services/types the query itself used, so a gap count printed beside a scoped result
  // set describes THAT result set — an unscoped (index-global) count next to it would be read as
  // belonging to it and would not.
  const gapScope = { services, types };

  const db = requireDb(ctx);

  // --not-touching: probe the substrate FIRST. On an empty `pr_files_state`, every uncovered PR
  // would trivially satisfy "does not touch this path" — a confident false positive, not an
  // incomplete answer — so an empty substrate refuses rather than silently answering.
  // Spec § 8: negation predicates do not compose in one query, so `notTouching` takes priority if
  // both negation params are somehow supplied together.
  if (notTouching !== undefined) {
    const probeResult = probePrFileCoverage(db);
    const predicate = buildNotTouchingSql(notTouching);
    // Embedded as a subquery, never materialised into one bind parameter per matching id: SQLite
    // has a ~65,535 bind-parameter ceiling per statement, so a large matching set would otherwise
    // throw instead of answering. The subquery costs exactly its own parameter count (one, here)
    // no matter how many rows it matches.
    const idInSql = toPositionalSubquery(predicate);
    const composed = buildItemListSql({ ...baseParams, idInSql });
    if (!probeResult.passed) {
      return {
        kind: "hit",
        value: missingSubstrateRefusal(
          "no PR file-coverage data is indexed, so which PRs do not touch a path cannot be verified",
          "sync a connector that populates PR changed-file coverage (GitHub/GitLab), then retry",
          explain
            ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
            : undefined,
        ),
      };
    }
    const items = requireLocalIndex(ctx).listItems({ ...baseParams, idInSql });
    const gaps = countNotTouchingExclusions(db, gapScope);
    const explainBlock: QueryExplain = {
      sql: composed.sql,
      params: composed.vals,
      substrate: probeResult,
    };
    return {
      kind: "hit",
      value: {
        items,
        meta: { limit, total: items.length },
        gaps,
        ...(explain ? { explain: explainBlock } : {}),
      },
    };
  }

  // --no-downstream-incident: same probe-first shape, over the `correlates_with` substrate.
  if (noDownstreamIncident) {
    const probeResult = probeCorrelatesWith(db);
    const predicate = buildNoDownstreamIncidentSql();
    const idInSql = toPositionalSubquery(predicate);
    const composed = buildItemListSql({ ...baseParams, idInSql });
    if (!probeResult.passed) {
      return {
        kind: "hit",
        value: missingSubstrateRefusal(
          "no `correlates_with` edges are indexed, so which deployments have no downstream " +
            "incident cannot be verified",
          "run a sync that populates deployment-to-incident correlation, then retry",
          explain
            ? { sql: composed.sql, params: composed.vals, substrate: probeResult }
            : undefined,
        ),
      };
    }
    const items = requireLocalIndex(ctx).listItems({ ...baseParams, idInSql });
    // The Task 2 -> Task 3 ruling: an ungraphed deployment is silently DROPPED by the predicate's
    // INNER JOIN — fail-closed and correct — but must not be dropped UNCOUNTED. See
    // `countNoDownstreamIncidentExclusions`'s doc comment for why it is labelled "no graph entity
    // of the required type" rather than "not graphed".
    const gaps = countNoDownstreamIncidentExclusions(db, gapScope);
    const explainBlock: QueryExplain = {
      sql: composed.sql,
      params: composed.vals,
      substrate: probeResult,
    };
    return {
      kind: "hit",
      value: {
        items,
        meta: { limit, total: items.length },
        gaps,
        ...(explain ? { explain: explainBlock } : {}),
      },
    };
  }

  // Plain path — no negation predicate requested. `--explain` still works here: the spec (§ 5)
  // requires it on ANY `query` invocation, not only negation ones, so it is attached on every
  // return path rather than gated inside the negation branches above.
  const items = requireLocalIndex(ctx).listItems(baseParams);
  if (!explain) {
    return { kind: "hit", value: { items, meta: { limit, total: items.length } } };
  }
  const built = buildItemListSql(baseParams);
  const explainBlock: QueryExplain = { sql: built.sql, params: built.vals };
  return {
    kind: "hit",
    value: { items, meta: { limit, total: items.length }, explain: explainBlock },
  };
}

async function rpcIndexQuerySql(
  params: unknown,
  ctx: DiagnosticsRpcContext,
): Promise<DiagnosticsRpcOutcome> {
  const rec = asRecord(params);
  const sql = typeof rec?.["sql"] === "string" ? rec["sql"] : "";
  try {
    const dbPath = join(ctx.dataDir, "nimbus.db");
    const rows = await runReadOnlySelect(dbPath, sql);
    return { kind: "hit", value: { rows, meta: { count: rows.length } } };
  } catch (e) {
    if (e instanceof SqlGuardError) {
      throw new DiagnosticsRpcError(-32602, e.message);
    }
    throw e;
  }
}

function rpcDiagSlowQueries(params: unknown, ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const rec = asRecord(params);
  let limit = 50;
  if (rec !== undefined && typeof rec["limit"] === "number" && Number.isFinite(rec["limit"])) {
    limit = Math.min(500, Math.max(1, Math.floor(rec["limit"])));
  }
  const rawSinceSlow = rec?.["sinceMs"];
  const sinceMs =
    typeof rawSinceSlow === "number" && Number.isFinite(rawSinceSlow)
      ? Math.floor(rawSinceSlow)
      : 0;
  const d = requireDb(ctx);
  const hasTable = d
    .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='slow_query_log'")
    .get() as { 1: number } | null;
  if (hasTable === null) {
    return { kind: "hit", value: { rows: [] } };
  }
  const rows = d
    .query(
      `SELECT id, query_text, latency_ms, query_type, recorded_at
           FROM slow_query_log WHERE recorded_at >= ? ORDER BY recorded_at DESC LIMIT ?`,
    )
    .all(sinceMs, limit) as Record<string, unknown>[];
  return { kind: "hit", value: { rows } };
}

function rpcTelemetryPreview(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  if (existsSync(join(ctx.dataDir, ".nimbus-telemetry-disabled"))) {
    return {
      kind: "hit",
      value: {
        disabled: true,
        message: "Telemetry disabled via nimbus telemetry disable (local marker file).",
      },
    };
  }
  const d = requireDb(ctx);
  const m = collectIndexMetrics(d);
  return {
    kind: "hit",
    value: buildTelemetryPreview({
      nimbusVersion: ctx.gatewayVersion,
      queryLatencyP50Ms: m.queryLatencyP50Ms,
      queryLatencyP95Ms: m.queryLatencyP95Ms,
      queryLatencyP99Ms: m.queryLatencyP99Ms,
      db: d,
    }),
  };
}

function rpcDiagSnapshot(ctx: DiagnosticsRpcContext): DiagnosticsRpcOutcome {
  const d = requireDb(ctx);
  const health = getAllConnectorHealth(d).map(serializeHealthSnapshot);
  const metrics = serializeMetrics(d);
  const audit = requireLocalIndex(ctx).listAudit(10);
  const watchers = listWatchers(d).map((w) => ({
    id: w.id,
    name: w.name,
    enabled: w.enabled === 1,
    lastFiredAtMs: w.last_fired_at,
  }));
  const pendingConsent = ctx.consent.pendingCount();
  return {
    kind: "hit",
    value: {
      gateway: {
        version: ctx.gatewayVersion,
        uptimeMs: Date.now() - ctx.startedAtMs,
      },
      connectorHealth: health,
      index: metrics,
      hitl: { pendingConsentRequests: pendingConsent },
      watchers,
      auditLogTail: audit,
      extensions: {
        disabled_pre_t2: preT2DisabledCount(),
        signature_disabled_count: signatureDisabledRegistry.count(),
        ...(ctx.autoUpdateDiag === undefined
          ? {}
          : {
              auto_update: {
                cached_updates_count: ctx.autoUpdateDiag.cachedUpdatesCount(),
                interval_hours: ctx.autoUpdateDiag.intervalHours,
                air_gap_blocked: ctx.autoUpdateDiag.airGapBlocked,
              },
            }),
      },
      sandbox: buildSandboxDiagPayload(ctx.sandboxRunner),
    },
  };
}

export function dispatchDiagnosticsRpc(
  method: string,
  params: unknown,
  ctx: DiagnosticsRpcContext,
): DiagnosticsRpcOutcome | Promise<DiagnosticsRpcOutcome> {
  switch (method) {
    case "config.validate":
      return rpcConfigValidate(ctx);
    case "telemetry.disableMark":
      return rpcTelemetryDisableMark(ctx);
    case "db.verify":
      return rpcDbVerify(ctx);
    case "db.repair":
      return rpcDbRepair(params, ctx);
    case "db.snapshot.take":
      return rpcDbSnapshotTake(ctx);
    case "db.snapshots.list":
      return rpcDbSnapshotsList(ctx);
    case "db.backups.list":
      return rpcDbBackupsList(ctx);
    case "db.snapshots.prune":
      return rpcDbSnapshotsPrune(params, ctx);
    case "db.restore.preview":
      return rpcDbRestorePreview(params, ctx);
    case "db.getMeta":
      return rpcDbGetMeta(params, ctx);
    case "db.setMeta":
      return rpcDbSetMeta(params, ctx);
    case "index.metrics":
      return rpcIndexMetrics(ctx);
    case "index.queryItems":
      return rpcIndexQueryItems(params, ctx);
    case "index.querySql":
      return rpcIndexQuerySql(params, ctx);
    case "diag.slowQueries":
      return rpcDiagSlowQueries(params, ctx);
    case "telemetry.preview":
      return rpcTelemetryPreview(ctx);
    case "diag.snapshot":
      return rpcDiagSnapshot(ctx);
    case "telemetry.getStatus": {
      const disabled = existsSync(join(ctx.dataDir, ".nimbus-telemetry-disabled"));
      if (disabled) return { kind: "hit", value: { enabled: false } };
      if (ctx.localIndex === undefined) {
        return { kind: "hit", value: { enabled: true } };
      }
      const d = ctx.localIndex.getDatabase();
      const m = collectIndexMetrics(d);
      const preview = buildTelemetryPreview({
        nimbusVersion: ctx.gatewayVersion,
        queryLatencyP50Ms: m.queryLatencyP50Ms,
        queryLatencyP95Ms: m.queryLatencyP95Ms,
        queryLatencyP99Ms: m.queryLatencyP99Ms,
        db: d,
      });
      return { kind: "hit", value: { enabled: true, ...preview } };
    }
    case "telemetry.setEnabled": {
      const p = params as { enabled?: unknown } | null;
      if (p === null || typeof p.enabled !== "boolean") {
        throw new DiagnosticsRpcError(-32602, "telemetry.setEnabled requires enabled:boolean");
      }
      const markerPath = join(ctx.dataDir, ".nimbus-telemetry-disabled");
      if (p.enabled) {
        if (existsSync(markerPath)) {
          assertTelemetryDisablePathSafe(markerPath);
          unlinkSync(markerPath);
        }
      } else {
        assertTelemetryDisablePathSafe(markerPath);
        writeFileSync(markerPath, `${String(Date.now())}\n`, { mode: 0o600 });
      }
      return { kind: "hit", value: { enabled: p.enabled } };
    }
    case "diag.getVersion": {
      return {
        kind: "hit",
        value: {
          version: ctx.gatewayVersion,
          commit: process.env["NIMBUS_BUILD_COMMIT"] ?? null,
          buildId: process.env["NIMBUS_BUILD_ID"] ?? null,
          uptimeMs: Date.now() - ctx.startedAtMs,
        },
      };
    }
    default:
      return { kind: "miss" };
  }
}
