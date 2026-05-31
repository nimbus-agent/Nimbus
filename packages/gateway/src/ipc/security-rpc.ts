import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { type ScanItem, type SecurityFinding, scanItemsForSecrets } from "../security/scan.ts";
import { SECRET_PATTERNS } from "../security/secret-patterns.ts";

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
}

function* iterateScannableItems(db: Database): Generator<ScanItem> {
  const rows = db
    .query(
      `SELECT i.id, i.service, i.type, i.title, i.body_preview, i.metadata,
              i.modified_at, i.url
         FROM item AS i
         LEFT JOIN sync_state AS s ON s.connector_id = i.service
        WHERE COALESCE(s.depth, 'summary') != 'metadata_only'`,
    )
    .iterate() as IterableIterator<ItemRow>;
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
    };
  }
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

export async function dispatchSecurityRpc(
  method: string,
  _params: unknown,
  ctx: SecurityRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: SecurityScanResult }> {
  if (method !== "security.scan") return { kind: "miss" };
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();

  const { skipped_connectors, items_skipped_depth } = loadSkippedDepth(ctx.db);
  const pure = scanItemsForSecrets(iterateScannableItems(ctx.db), SECRET_PATTERNS, nowMs);

  const value: SecurityScanResult = {
    scanned_at_ms: pure.scanned_at_ms,
    items_scanned: pure.items_scanned,
    items_skipped_depth,
    findings_count: pure.findings_count,
    findings: pure.findings,
    skipped_connectors,
  };

  appendAuditEntry(ctx.db, {
    actionType: "security.scan_completed",
    hitlStatus: "not_required",
    actionJson: JSON.stringify({
      scanned_at_ms: value.scanned_at_ms,
      items_scanned: value.items_scanned,
      items_skipped_depth: value.items_skipped_depth,
      findings_count: value.findings_count,
      skipped_connectors_count: skipped_connectors.length,
    }),
    timestamp: nowMs,
  });

  return { kind: "hit", value };
}
