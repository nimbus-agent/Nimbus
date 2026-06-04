import type { Database } from "bun:sqlite";
import {
  DEFAULT_NIMBUS_SECURITY_TOML,
  loadNimbusSecurityFromConfigDir,
} from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { lookupBlame } from "../security/blame-store.ts";
import {
  type BlameResolution,
  type ScanItem,
  type SecurityFinding,
  scanItemsForSecrets,
} from "../security/scan.ts";
import { effectivePatterns } from "../security/secret-patterns.ts";
import { LongRunningJobRegistry } from "./_lib/long-running.ts";

export class SecurityRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "SecurityRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface SecurityRpcContext {
  readonly db: Database;
  readonly nowMs?: () => number;
  readonly notify?: (method: string, payload: Record<string, unknown>) => void;
  readonly configDir?: string;
}

export interface SecurityScanParams {
  readonly service?: string;
  readonly extended?: boolean;
}

export interface SkippedConnector {
  readonly service: string;
  readonly depth: "metadata_only";
}

export interface SecurityScanResult {
  readonly scanned_at_ms: number;
  readonly items_scanned: number;
  readonly items_skipped_depth: number;
  readonly findings_count: number;
  readonly muted_count: number;
  readonly findings: readonly SecurityFinding[];
  readonly skipped_connectors: readonly SkippedConnector[];
}

interface ItemRow {
  id: string;
  service: string;
  type: string;
  title: string;
  body_preview: string | null;
  metadata: string | null;
  modified_at: number;
  url: string | null;
  external_id: string;
}

function* iterateScannableItems(db: Database, service?: string): Generator<ScanItem> {
  const where = ["COALESCE(s.depth, 'summary') != 'metadata_only'"];
  const args: string[] = [];
  if (service !== undefined && service !== "") {
    where.push("i.service = ?");
    args.push(service);
  }
  const rows = db
    .query(
      `SELECT i.id, i.service, i.type, i.title, i.body_preview, i.metadata,
              i.modified_at, i.url, i.external_id
         FROM item AS i
         LEFT JOIN sync_state AS s ON s.connector_id = i.service
        WHERE ${where.join(" AND ")}`,
    )
    .iterate(...args) as IterableIterator<ItemRow>;
  for (const row of rows) {
    yield {
      id: row.id,
      service: row.service,
      type: row.type,
      title: row.title,
      body_preview: row.body_preview,
      metadata: row.metadata,
      modified_at: row.modified_at,
      url: row.url,
      external_id: row.external_id,
    };
  }
}

function countScannableItems(db: Database, service?: string): number {
  const where = ["COALESCE(s.depth, 'summary') != 'metadata_only'"];
  const args: string[] = [];
  if (service !== undefined && service !== "") {
    where.push("i.service = ?");
    args.push(service);
  }
  const row = db
    .query(
      `SELECT COUNT(*) AS n FROM item AS i
         LEFT JOIN sync_state AS s ON s.connector_id = i.service
        WHERE ${where.join(" AND ")}`,
    )
    .get(...args) as { n: number } | undefined;
  return row?.n ?? 0;
}

function blameResolverFor(
  db: Database,
): (item: ScanItem, absLine: number) => BlameResolution | null {
  return (item, absLine) => {
    if (item.metadata === null) return null;
    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(item.metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
    const repoRoot = meta["repoRoot"];
    const file = meta["file"];
    if (typeof repoRoot !== "string" || typeof file !== "string") return null;
    return lookupBlame(db, repoRoot, file, absLine);
  };
}

function loadSkippedDepth(db: Database): {
  skipped_connectors: SkippedConnector[];
  items_skipped_depth: number;
} {
  const services = db
    .query(
      `SELECT connector_id FROM sync_state WHERE depth = 'metadata_only' ORDER BY connector_id ASC`,
    )
    .all() as Array<{ connector_id: string }>;
  if (services.length === 0) return { skipped_connectors: [], items_skipped_depth: 0 };

  const skipped_connectors: SkippedConnector[] = services.map((r) => ({
    service: r.connector_id,
    depth: "metadata_only" as const,
  }));

  const placeholders = services.map(() => "?").join(", ");
  const row = db
    .query(`SELECT COUNT(*) AS n FROM item WHERE service IN (${placeholders})`)
    .get(...services.map((s) => s.connector_id)) as { n: number } | undefined;

  return { skipped_connectors, items_skipped_depth: row?.n ?? 0 };
}

export interface RunSecurityScanOptions {
  readonly nowMs: number;
  readonly configDir?: string;
  readonly service?: string;
  readonly extended?: boolean;
}

const PROGRESS_EVERY = 200;

/**
 * The scan core. Streams scannable items (optionally filtered by service),
 * applies the configured pattern tier + allowlist mute, attaches indexed blame,
 * emits progress, honors cancellation, writes the audit row, and returns the
 * full result. Used directly by tests and wrapped as a long-running job by
 * `dispatchSecurityRpc`.
 */
export async function runSecurityScan(
  db: Database,
  opts: RunSecurityScanOptions,
  progress?: (payload: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<SecurityScanResult> {
  const sec =
    opts.configDir !== undefined
      ? loadNimbusSecurityFromConfigDir(opts.configDir)
      : DEFAULT_NIMBUS_SECURITY_TOML;
  const allowlist = new Set(sec.allowlistFingerprints);
  const extended = opts.extended ?? sec.extendedPatterns;
  const patterns = effectivePatterns(extended);
  const resolveBlame = blameResolverFor(db);

  const { skipped_connectors, items_skipped_depth } = loadSkippedDepth(db);
  const total = countScannableItems(db, opts.service);

  const findings: SecurityFinding[] = [];
  let items_scanned = 0;
  let muted_count = 0;
  for (const item of iterateScannableItems(db, opts.service)) {
    if (signal?.aborted === true) break;
    const r = scanItemsForSecrets([item], patterns, opts.nowMs, { allowlist, resolveBlame });
    findings.push(...r.findings);
    muted_count += r.muted_count;
    items_scanned += r.items_scanned;
    if (progress !== undefined && items_scanned % PROGRESS_EVERY === 0) {
      progress({ scanned: items_scanned, total });
    }
  }

  const value: SecurityScanResult = {
    scanned_at_ms: opts.nowMs,
    items_scanned,
    items_skipped_depth,
    findings_count: findings.length,
    muted_count,
    findings,
    skipped_connectors,
  };

  appendAuditEntry(db, {
    actionType: "security.scan_completed",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({
      scanned_at_ms: value.scanned_at_ms,
      items_scanned: value.items_scanned,
      items_skipped_depth: value.items_skipped_depth,
      findings_count: value.findings_count,
      muted_count: value.muted_count,
      skipped_connectors_count: skipped_connectors.length,
    }),
    timestamp: opts.nowMs,
  });

  if (progress !== undefined) progress({ scanned: items_scanned, total });
  return value;
}

const securityScanRegistry = new LongRunningJobRegistry();

/** Test seam: await a running scan job's completion. */
export function awaitSecurityScanJob(jobId: string): Promise<void> {
  return securityScanRegistry.awaitJob(jobId);
}

function parseScanParams(params: unknown): SecurityScanParams {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return {};
  const rec = params as Record<string, unknown>;
  const out: { service?: string; extended?: boolean } = {};
  if (typeof rec["service"] === "string" && rec["service"] !== "") out.service = rec["service"];
  if (rec["extended"] === true) out.extended = true;
  return out;
}

export async function dispatchSecurityRpc(
  method: string,
  params: unknown,
  ctx: SecurityRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: unknown }> {
  if (method === "security.scanCancel") {
    const rec =
      params !== null && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const jobId = rec["jobId"];
    if (typeof jobId !== "string") {
      throw new SecurityRpcError(-32602, "params.jobId is required");
    }
    return { kind: "hit", value: { cancelled: securityScanRegistry.cancel(jobId) } };
  }
  if (method !== "security.scan") return { kind: "miss" };

  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  const p = parseScanParams(params);
  const opts: RunSecurityScanOptions = {
    nowMs,
    ...(ctx.configDir === undefined ? {} : { configDir: ctx.configDir }),
    ...(p.service === undefined ? {} : { service: p.service }),
    ...(p.extended === undefined ? {} : { extended: p.extended }),
  };
  const handle = securityScanRegistry.start({
    jobIdPrefix: "secscan",
    progressMethod: "security.scanProgress",
    doneMethod: "security.scanDone",
    errorMethod: "security.scanError",
    emit: (m, payload) => ctx.notify?.(m, payload),
    run: (progress, signal) => runSecurityScan(ctx.db, opts, progress, signal),
  });
  return { kind: "hit", value: { jobId: handle.jobId } };
}
