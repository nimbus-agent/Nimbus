import type { Database } from "bun:sqlite";
import type { NimbusItem } from "@nimbus-dev/sdk";
import { getConnectorHealth } from "../connectors/health.ts";
import type { ReindexDepth } from "../connectors/reindex.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import {
  DEFAULT_SLOW_QUERY_THRESHOLD_MS,
  latencyRingBuffer,
  type QueryLatencyKind,
  recordSlowQuery,
} from "../db/latency-ring-buffer.ts";
import { dbRun } from "../db/write.ts";
import {
  compositeSearchScore,
  normalizeHigherIsBetter,
  recencyScore,
  servicePriorityScore,
} from "../engine/search-ranking.ts";
import {
  type TraverseGraphOptions,
  type TraverseGraphResult,
  traverseGraph as traverseGraphSubgraph,
} from "../graph/relationship-graph.ts";
import { prunePeopleAfterServiceRemoval } from "../people/prune.ts";
import { hybridSearch } from "../search/hybrid.ts";
import type { HybridSearchOptions } from "../search/hybrid-types.ts";
import {
  clearSchedulerCursor,
  countItemsForService,
  deleteSchedulerStateRow,
  listAllSchedulerStates,
  loadSchedulerState,
  type SchedulerStateRow,
  setPaused,
  upsertSchedulerRegistration,
} from "../sync/scheduler-store.ts";
import type { SyncStatus } from "../sync/types.ts";
import { buildItemListSql, type ItemListQueryParams } from "./item-list-query.ts";
import {
  deleteAllItemsForService,
  deleteItemByPrimaryKey,
  itemExternalIdFromInput,
  itemPrimaryKey,
  upsertNimbusItemIntoItemTable,
} from "./item-store.ts";
import {
  type MigrationBackupOptions,
  readIndexedUserVersion,
  runIndexedSchemaMigrations,
} from "./migrations/runner.ts";
import type { RankedIndexItem } from "./ranked-item.ts";
import { ensureSqliteVecForConnection } from "./sqlite-vec-load.ts";

export type { TraverseGraphOptions, TraverseGraphResult } from "../graph/relationship-graph.ts";
export { RAW_META_MAX_BYTES } from "./constants.ts";
export type { RankedIndexItem } from "./ranked-item.ts";

/**
 * A `NimbusItem` plus the index primary key (`service:external_id`).
 *
 * `rowToItem` sets `id` to the bare `external_id`, which is NOT unique across
 * services, so list consumers need the composite key for stable identity.
 * Mirrors how `RankedIndexItem` exposes `indexPrimaryKey`.
 */
export type IndexedItem = NimbusItem & { indexPrimaryKey: string };

export type SearchRankOptions = {
  nowMs?: number;
  searchServicePriority?: ReadonlyMap<string, number>;
  candidateLimit?: number;
};

export type AuditEntry = {
  id: number;
  actionType: string;
  hitlStatus: "approved" | "rejected" | "not_required";
  actionJson: string;
  timestamp: number;
};

export type IndexSearchQuery = {
  service?: string;
  itemType?: string;
  name?: string;
  limit?: number;
};

type ItemRow = {
  id: string;
  service: string;
  type: string;
  external_id: string;
  title: string;
  body_preview: string | null;
  url: string | null;
  canonical_url: string | null;
  modified_at: number;
  author_id: string | null;
  metadata: string | null;
  synced_at: number;
  pinned: number;
};

function ftsTitleMatchQuery(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return "";
  }
  return tokens
    .map((t) => {
      const escaped = t.replaceAll('"', '""');
      return `(title : "${escaped}"* OR body_preview : "${escaped}"*)`;
    })
    .join(" AND ");
}

function applyItemMetadataColumn(item: NimbusItem, metadata: string): void {
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const rec = parsed as Record<string, unknown>;
    item.rawMeta = { ...rec };
    const mt = rec["mime_type"];
    if (typeof mt === "string") {
      item.mimeType = mt;
    }
    const sb = rec["size_bytes"];
    if (typeof sb === "number" && Number.isFinite(sb)) {
      item.sizeBytes = sb;
    }
    const pid = rec["parent_id"];
    if (typeof pid === "string") {
      item.parentId = pid;
    }
    const ca = rec["created_at"];
    if (typeof ca === "number" && Number.isFinite(ca)) {
      item.createdAt = ca;
    }
    delete item.rawMeta["mime_type"];
    delete item.rawMeta["size_bytes"];
    delete item.rawMeta["parent_id"];
    delete item.rawMeta["created_at"];
    delete item.rawMeta["legacy_raw_meta"];
    if (Object.keys(item.rawMeta).length === 0) {
      delete item.rawMeta;
    }
  } catch {
    /* leave rawMeta unset */
  }
}

function rowToItem(row: ItemRow): NimbusItem {
  const item: NimbusItem = {
    id: String(row.external_id),
    service: String(row.service),
    itemType: String(row.type),
    name: String(row.title),
  };
  item.modifiedAt = Number(row.modified_at);
  if (row.url != null && row.url !== "") {
    item.url = String(row.url);
  }
  if (row.metadata != null && row.metadata !== "") {
    applyItemMetadataColumn(item, String(row.metadata));
  }
  return item;
}

function rowToRankedItem(
  row: ItemRow,
  score: number,
  duplicates?: readonly string[],
): RankedIndexItem {
  const base = rowToItem(row);
  const canon = row.canonical_url;
  const trimmed = canon != null && canon !== "" ? canon.trim() : "";
  const item: RankedIndexItem = {
    ...base,
    score,
    indexPrimaryKey: row.id,
    indexedType: String(row.type),
    ...(trimmed === "" ? {} : { canonicalUrl: trimmed }),
    ...(duplicates !== undefined && duplicates.length > 0 ? { duplicates } : {}),
  };
  return item;
}

function dedupeRankedByCanonicalUrl(
  scored: Array<{ row: ItemRow; score: number }>,
): RankedIndexItem[] {
  const out: RankedIndexItem[] = [];
  const canonicalToOutIdx = new Map<string, number>();
  for (const { row, score } of scored) {
    const canon = row.canonical_url;
    if (canon === null || canon === undefined || canon.trim() === "") {
      out.push(rowToRankedItem(row, score));
      continue;
    }
    const c = canon.trim();
    const idx = canonicalToOutIdx.get(c);
    if (idx === undefined) {
      canonicalToOutIdx.set(c, out.length);
      out.push(rowToRankedItem(row, score));
      continue;
    }
    const prev = out[idx];
    if (prev === undefined) {
      out.push(rowToRankedItem(row, score));
      continue;
    }
    const dups = [...(prev.duplicates ?? []), row.service];
    out[idx] = { ...prev, duplicates: dups };
  }
  return out;
}

function stripRankedToNimbus(r: RankedIndexItem): NimbusItem {
  const {
    score: _sc,
    indexPrimaryKey: _pk,
    indexedType: _it,
    duplicates: _dup,
    canonicalUrl: _cu,
    semanticSnippet: _ss,
    bm25Rank: _br,
    vectorRank: _vr,
    ...rest
  } = r;
  return rest;
}

export type SemanticSearchDeps = {
  model: string;
  embedQuery: (text: string) => Promise<Float32Array | null>;
  embedQueryDual: (text: string) => Promise<{
    vec384: Float32Array | null;
    vec1536: Float32Array | null;
    model384: string | null;
    model1536: string | null;
  }>;
};

export type LocalIndexOptions = {
  scheduleItemEmbedding?: (itemId: string) => void;
  semanticSearch?: SemanticSearchDeps;
};

export interface LanPeerRow {
  peer_id: string;
  peer_pubkey: Uint8Array;
  direction: "inbound" | "outbound";
  host_ip: string | null;
  host_port: number | null;
  display_name: string | null;
  write_allowed: number;
  paired_at: string;
  last_seen_at: string | null;
}

export const CURRENT_SCHEMA_VERSION = 46;

const ALLOWED_META_KEYS = new Set<string>(["onboarding_completed"]);

export function isAllowedMetaKey(key: string): boolean {
  return ALLOWED_META_KEYS.has(key);
}

export class LocalIndex {
  static readonly SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

  static ensureSchema(db: Database, backup?: MigrationBackupOptions): void {
    runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION, backup);
    ensureSqliteVecForConnection(db, readIndexedUserVersion(db));
    dbRun(db, "PRAGMA foreign_keys = ON");
  }

  constructor(
    private readonly db: Database,
    private readonly options?: LocalIndexOptions,
  ) {}

  private get semanticSearch(): SemanticSearchDeps | undefined {
    return this.options?.semanticSearch;
  }

  getDatabase(): Database {
    return this.db;
  }

  private emitQueryLatency(
    kind: QueryLatencyKind,
    latencyMs: number,
    slowHint: string | null,
  ): void {
    const at = Date.now();
    latencyRingBuffer.push({ latencyMs, queryType: kind, recordedAt: at });
    recordSlowQuery(this.db, {
      queryText: slowHint,
      latencyMs,
      queryType: kind,
      recordedAt: at,
      thresholdMs: DEFAULT_SLOW_QUERY_THRESHOLD_MS,
    });
  }

  private static rowToPersistedSyncStatus(db: Database, row: SchedulerStateRow): SyncStatus {
    let status: SyncStatus["status"] = "ok";
    if (row.paused === 1) {
      status = "paused";
    } else if (row.status === "error") {
      status = "error";
    } else if (row.status === "backoff") {
      status = "backoff";
    }
    const health = getConnectorHealth(db, row.service_id);
    const depthRow = db
      .query(`SELECT depth FROM sync_state WHERE connector_id = ?`)
      .get(row.service_id) as { depth: string | null } | null | undefined;
    const depth = (depthRow?.depth ?? "summary") as ReindexDepth;
    return {
      serviceId: row.service_id,
      status,
      lastSyncAt: row.last_sync_at,
      nextSyncAt: row.next_sync_at,
      intervalMs: row.interval_ms,
      itemCount: countItemsForService(db, row.service_id),
      lastError: row.error_msg,
      consecutiveFailures: row.consecutive_failures,
      healthState: health.state,
      healthRetryAfterMs: health.retryAfter === undefined ? null : health.retryAfter.getTime(),
      depth,
      enabled: status !== "paused",
    };
  }

  persistedConnectorStatuses(serviceIdFilter?: string): SyncStatus[] {
    if (serviceIdFilter !== undefined && serviceIdFilter !== "") {
      const row = loadSchedulerState(this.db, serviceIdFilter);
      if (row === null) {
        return [];
      }
      return [LocalIndex.rowToPersistedSyncStatus(this.db, row)];
    }
    const rows = listAllSchedulerStates(this.db);
    return rows.map((r) => LocalIndex.rowToPersistedSyncStatus(this.db, r));
  }

  ensureConnectorSchedulerRegistration(serviceId: string, intervalMs: number, now: number): void {
    upsertSchedulerRegistration(this.db, serviceId, intervalMs, now, false);
  }

  ensureGithubActionsSchedulerCompanionIfNeeded(params: {
    githubPatPresent: boolean;
    now: number;
    intervalMs: number;
  }): void {
    if (!params.githubPatPresent) {
      return;
    }
    if (loadSchedulerState(this.db, "github") === null) {
      return;
    }
    if (loadSchedulerState(this.db, "github_actions") !== null) {
      return;
    }
    upsertSchedulerRegistration(this.db, "github_actions", params.intervalMs, params.now, false);
  }

  ensureCircleciSchedulerCompanionIfNeeded(params: {
    circleciTokenPresent: boolean;
    now: number;
    intervalMs: number;
  }): void {
    if (!params.circleciTokenPresent) {
      return;
    }
    if (loadSchedulerState(this.db, "github") === null) {
      return;
    }
    if (loadSchedulerState(this.db, "circleci") !== null) {
      return;
    }
    upsertSchedulerRegistration(this.db, "circleci", params.intervalMs, params.now, false);
  }

  pauseConnectorSync(serviceId: string): void {
    if (loadSchedulerState(this.db, serviceId) === null) {
      throw new Error(`Unknown connector: ${serviceId}`);
    }
    setPaused(this.db, serviceId, true);
  }

  resumeConnectorSync(serviceId: string): void {
    if (loadSchedulerState(this.db, serviceId) === null) {
      throw new Error(`Unknown connector: ${serviceId}`);
    }
    setPaused(this.db, serviceId, false);
  }

  setConnectorSyncIntervalMs(serviceId: string, intervalMs: number, now: number): void {
    upsertSchedulerRegistration(this.db, serviceId, intervalMs, now, true);
  }

  setConnectorDepth(serviceId: string, depth: ReindexDepth): void {
    const rows = this.db
      .query(`UPDATE sync_state SET depth = ? WHERE connector_id = ?`)
      .run(depth, serviceId);
    if (rows.changes === 0) {
      dbRun(
        this.db,
        `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token, depth) VALUES (?, NULL, NULL, ?)`,
        [serviceId, depth],
      );
    }
  }

  getConnectorDepth(serviceId: string): ReindexDepth {
    const row = this.db
      .query(`SELECT depth FROM sync_state WHERE connector_id = ?`)
      .get(serviceId) as { depth: string } | null | undefined;
    if (row == null) {
      throw new Error(`unknown connector: ${serviceId}`);
    }
    return row.depth as ReindexDepth;
  }

  clearConnectorSyncCursor(serviceId: string): void {
    if (loadSchedulerState(this.db, serviceId) === null) {
      throw new Error(`Unknown connector: ${serviceId}`);
    }
    clearSchedulerCursor(this.db, serviceId);
  }

  removeConnectorIndexData(serviceId: string): number {
    return this.db.transaction(() => {
      const n = countItemsForService(this.db, serviceId);
      deleteAllItemsForService(this.db, serviceId);
      deleteSchedulerStateRow(this.db, serviceId);
      dbRun(this.db, "DELETE FROM sync_state WHERE connector_id = ?", [serviceId]);
      prunePeopleAfterServiceRemoval(this.db, serviceId);
      return n;
    })();
  }

  listItemsForAuthor(personId: string, limit: number): NimbusItem[] {
    const lim = Math.min(200, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(`SELECT * FROM item WHERE author_id = ? ORDER BY modified_at DESC LIMIT ?`)
      .all(personId, lim) as ItemRow[];
    return rows.map(rowToItem);
  }

  getBodyPreview(indexPrimaryKey: string): string | undefined {
    const row = this.db
      .query("SELECT body_preview FROM item WHERE id = ?")
      .get(indexPrimaryKey) as { body_preview: string | null } | null;
    const preview = row?.body_preview;
    if (typeof preview === "string" && preview.trim() !== "") {
      return preview;
    }
    return undefined;
  }

  traverseGraph(
    startRef: string,
    options?: TraverseGraphOptions,
  ): TraverseGraphResult | { error: string } {
    if (readIndexedUserVersion(this.db) < 7) {
      return { error: "Relationship graph requires local index schema v7 or newer" };
    }
    return traverseGraphSubgraph(this.db, startRef, options);
  }

  upsert(item: NimbusItem): void {
    upsertNimbusItemIntoItemTable(this.db, item, Date.now());
    const externalId = itemExternalIdFromInput(item.service, item.id);
    const pk = itemPrimaryKey(item.service, externalId);
    this.options?.scheduleItemEmbedding?.(pk);
  }

  delete(id: string): void {
    const byPk = this.db.query("SELECT id FROM item WHERE id = ?").get(id) as
      | { id: string }
      | null
      | undefined;
    if (byPk !== null && byPk !== undefined) {
      deleteItemByPrimaryKey(this.db, byPk.id);
      return;
    }
    const rows = this.db.query("SELECT id FROM item WHERE external_id = ?").all(id) as {
      id: string;
    }[];
    if (rows.length === 0) {
      return;
    }
    if (rows.length > 1) {
      throw new Error("delete id is ambiguous across services");
    }
    const pk = rows[0]?.id;
    if (pk !== undefined) {
      deleteItemByPrimaryKey(this.db, pk);
    }
  }

  private static searchFiltersAndParams(query: IndexSearchQuery): {
    filters: string[];
    params: Array<string | number>;
    whereExtra: string;
  } {
    const filters: string[] = [];
    const params: Array<string | number> = [];

    if (query.service !== undefined && query.service !== "") {
      filters.push("i.service = ?");
      params.push(query.service);
    }
    if (query.itemType !== undefined && query.itemType !== "") {
      filters.push("i.type = ?");
      params.push(query.itemType);
    }

    const whereExtra = filters.length > 0 ? `AND ${filters.join(" AND ")}` : "";
    return { filters, params, whereExtra };
  }

  private searchWithFtsOrderRank(
    fts: string,
    whereExtra: string,
    params: Array<string | number>,
    limit: number,
  ): ItemRow[] {
    const sql = `
        SELECT i.* FROM item i
        INNER JOIN item_fts ON i.rowid = item_fts.rowid
        WHERE item_fts MATCH ? ${whereExtra}
        ORDER BY rank
        LIMIT ?
      `;
    const allParams = [fts, ...params, limit];
    return this.db.query(sql).all(...allParams) as ItemRow[];
  }

  private searchWithoutFtsOrdered(
    filters: string[],
    params: Array<string | number>,
    limit: number,
  ): ItemRow[] {
    const orderClause = " ORDER BY i.modified_at DESC";
    const sql =
      filters.length > 0
        ? `SELECT i.* FROM item i WHERE ${filters.join(" AND ")}${orderClause} LIMIT ?`
        : `SELECT i.* FROM item i${orderClause} LIMIT ?`;
    const allParams = [...params, limit];
    return this.db.query(sql).all(...allParams) as ItemRow[];
  }

  searchRanked(query: IndexSearchQuery, options?: SearchRankOptions): RankedIndexItem[] {
    const t0 = performance.now();
    const candidateLimit = Math.min(500, Math.max(1, Math.floor(options?.candidateLimit ?? 500)));
    const now = options?.nowMs ?? Date.now();
    const priorities = options?.searchServicePriority ?? new Map<string, number>();

    const nameQ = query.name?.trim() ?? "";
    const useFts = nameQ.length > 0;
    const fts = useFts ? ftsTitleMatchQuery(nameQ) : "";

    try {
      if (useFts && fts === "") {
        return [];
      }

      const { filters, params, whereExtra } = LocalIndex.searchFiltersAndParams(query);

      let rows: ItemRow[];
      let normBm25: number[];

      if (useFts) {
        rows = this.searchWithFtsOrderRank(fts, whereExtra, params, candidateLimit);
        normBm25 =
          rows.length <= 1 ? rows.map(() => 1) : rows.map((_, i) => 1 - i / (rows.length - 1));
      } else {
        rows = this.searchWithoutFtsOrdered(filters, params, candidateLimit);
        normBm25 = rows.map(() => 0.5);
      }

      const scored: Array<{ row: ItemRow; score: number }> = rows.map((row, i) => {
        const mod = Number(row.modified_at);
        const rec = recencyScore(mod, now);
        const sp = servicePriorityScore(row.service, priorities);
        const bm = normBm25[i];
        const comp = compositeSearchScore(bm ?? 0.5, rec, sp);
        return { row, score: comp };
      });

      scored.sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return b.row.modified_at - a.row.modified_at;
      });

      const out = dedupeRankedByCanonicalUrl(scored);

      const limit = Math.min(500, Math.max(1, query.limit ?? 50));
      return out.slice(0, limit);
    } finally {
      const kind: QueryLatencyKind = useFts ? "fts" : "sql";
      const hint = useFts
        ? nameQ.slice(0, 200) || null
        : `browse:${query.service ?? "*"}:${query.itemType ?? "*"}`;
      this.emitQueryLatency(kind, performance.now() - t0, hint);
    }
  }

  async searchRankedAsync(
    query: IndexSearchQuery,
    options?: SearchRankOptions & { semantic?: boolean; contextChunks?: number },
  ): Promise<RankedIndexItem[]> {
    const nameQ = query.name?.trim() ?? "";
    const semanticOn = options?.semantic ?? true;
    const ss = this.semanticSearch;
    const uv = readIndexedUserVersion(this.db);
    const vecReady = ensureSqliteVecForConnection(this.db, uv);
    const canHybrid = semanticOn && nameQ !== "" && ss !== undefined && uv >= 6 && vecReady;

    if (canHybrid) {
      const t0 = performance.now();
      try {
        const dual = await ss.embedQueryDual(nameQ);
        const hybridOpts: HybridSearchOptions = {
          query: nameQ,
          limit: query.limit ?? 50,
          semantic: true,
          embeddingModel: ss.model,
          contextChunks: options?.contextChunks ?? 2,
        };
        if (query.service !== undefined && query.service !== "") {
          hybridOpts.service = query.service;
        }
        if (query.itemType !== undefined && query.itemType !== "") {
          hybridOpts.itemType = query.itemType;
        }
        if (dual.vec384 !== null) {
          hybridOpts.queryEmbedding = dual.vec384;
        }
        if (dual.vec1536 !== null && dual.model1536 !== null) {
          hybridOpts.queryEmbedding1536 = dual.vec1536;
          hybridOpts.embeddingModel1536 = dual.model1536;
        }
        const hybridResults = await hybridSearch(this.db, hybridOpts);

        const normRrf = normalizeHigherIsBetter(hybridResults.map((h) => h.rrfScore));
        const now = options?.nowMs ?? Date.now();
        const priorities = options?.searchServicePriority ?? new Map();

        return hybridResults.map((h, i) => {
          const row = h.item;
          const rec = recencyScore(row.modified_at, now);
          const sp = servicePriorityScore(row.service, priorities);
          const nr = normRrf[i] ?? 0.5;
          const comp = compositeSearchScore(nr, rec, sp);
          const base = rowToRankedItem(row, comp, h.duplicates);
          const ranked: RankedIndexItem = {
            ...base,
            bm25Rank: h.bm25Rank,
            vectorRank: h.vectorRank,
          };
          if (h.semanticSnippet !== undefined) {
            ranked.semanticSnippet = h.semanticSnippet;
          }
          return ranked;
        });
      } finally {
        this.emitQueryLatency("hybrid", performance.now() - t0, nameQ.slice(0, 200) || null);
      }
    }

    return this.searchRanked(query, options);
  }

  fetchMoreItems(
    service: string,
    indexedType: string,
    offset: number,
    limit: number,
  ): NimbusItem[] {
    const t0 = performance.now();
    const lim = Math.min(100, Math.max(1, Math.floor(limit)));
    const off = Math.max(0, Math.floor(offset));
    try {
      const rows = this.db
        .query(
          `SELECT * FROM item WHERE service = ? AND type = ? ORDER BY modified_at DESC LIMIT ? OFFSET ?`,
        )
        .all(service, indexedType, lim, off) as ItemRow[];
      return rows.map(rowToItem);
    } finally {
      this.emitQueryLatency("sql", performance.now() - t0, `fetchMore:${service}/${indexedType}`);
    }
  }

  search(query: IndexSearchQuery): NimbusItem[] {
    const ranked = this.searchRanked(query, {});
    return ranked.map(stripRankedToNimbus);
  }

  /**
   * List indexed items for `index.queryItems`.
   *
   * Owns the SQL and the row mapping together so no caller ever sees a raw V3
   * row: the snake_case column names must not cross the IPC boundary.
   */
  listItems(params: ItemListQueryParams): IndexedItem[] {
    const { sql, vals } = buildItemListSql(params);
    const rows = this.db.query(sql).all(...vals) as ItemRow[];
    return rows.map((row) => ({ ...rowToItem(row), indexPrimaryKey: String(row.id) }));
  }

  recordSync(connectorId: string, token: string): void {
    const now = Date.now();
    dbRun(
      this.db,
      `INSERT INTO sync_state (connector_id, last_sync_at, next_sync_token)
       VALUES (?, ?, ?)
       ON CONFLICT(connector_id) DO UPDATE SET
         last_sync_at = excluded.last_sync_at,
         next_sync_token = excluded.next_sync_token`,
      [connectorId, now, token],
    );
  }

  getLastSyncToken(connectorId: string): string | null {
    const row = this.db
      .query("SELECT next_sync_token FROM sync_state WHERE connector_id = ?")
      .get(connectorId) as { next_sync_token: string | null } | null | undefined;
    const t = row?.next_sync_token;
    return t == null || t === "" ? null : t;
  }

  recordAudit(entry: {
    actionType: string;
    hitlStatus: AuditEntry["hitlStatus"];
    actionJson: string;
    timestamp: number;
    sessionId?: string;
  }): void {
    appendAuditEntry(this.db, entry);
  }

  get rawDb(): Database {
    return this.db;
  }

  listAuditWithChain(limit: number): Array<AuditEntry & { rowHash: string; prevHash: string }> {
    const capped = Math.min(10_000, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT id, action_type, hitl_status, action_json, timestamp, row_hash, prev_hash
         FROM audit_log ORDER BY id ASC LIMIT ?`,
      )
      .all(capped) as Array<{
      id: number;
      action_type: string;
      hitl_status: string;
      action_json: string;
      timestamp: number;
      row_hash: string;
      prev_hash: string;
    }>;
    return rows.map((r) => {
      const status = r.hitl_status;
      if (status !== "approved" && status !== "rejected" && status !== "not_required") {
        throw new Error("Corrupt audit_log row: invalid hitl_status");
      }
      return {
        id: r.id,
        actionType: r.action_type,
        hitlStatus: status,
        actionJson: r.action_json,
        timestamp: r.timestamp,
        rowHash: r.row_hash,
        prevHash: r.prev_hash,
      };
    });
  }

  getAuditVerifiedThroughId(): number {
    const row = this.db
      .query(`SELECT value FROM _meta WHERE key = 'audit_verified_through_id'`)
      .get() as { value: string } | undefined;
    const n = row === undefined ? 0 : Number.parseInt(row.value, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  setAuditVerifiedThroughId(id: number): void {
    const v = Math.max(0, Math.floor(id));
    dbRun(
      this.db,
      `INSERT INTO _meta (key, value) VALUES ('audit_verified_through_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [String(v)],
    );
  }

  getMeta(key: string): string | null {
    if (!ALLOWED_META_KEYS.has(key)) {
      throw new Error(`db.getMeta: key '${key}' is not in the whitelist`);
    }
    const row = this.db.query("SELECT value FROM _meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    if (!ALLOWED_META_KEYS.has(key)) {
      throw new Error(`db.setMeta: key '${key}' is not in the whitelist`);
    }
    dbRun(
      this.db,
      `INSERT INTO _meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  public listLanPeers(): LanPeerRow[] {
    return this.db.query(`SELECT * FROM lan_peers ORDER BY paired_at ASC`).all() as LanPeerRow[];
  }

  public addLanPeer(params: {
    peerId: string;
    peerPubkey: Uint8Array;
    direction: "inbound" | "outbound";
    hostIp?: string;
    hostPort?: number;
    displayName?: string;
  }): void {
    dbRun(
      this.db,
      `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, host_ip, host_port, display_name, write_allowed, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(peer_pubkey) DO UPDATE SET
         host_ip = excluded.host_ip,
         host_port = excluded.host_port,
         display_name = excluded.display_name,
         direction = excluded.direction,
         paired_at = excluded.paired_at`,
      [
        params.peerId,
        Buffer.from(params.peerPubkey),
        params.direction,
        params.hostIp ?? null,
        params.hostPort ?? null,
        params.displayName ?? null,
        new Date().toISOString(),
      ],
    );
  }

  public grantLanWrite(peerId: string): void {
    dbRun(
      this.db,
      `UPDATE lan_peers SET write_allowed = 1 WHERE peer_id = ? AND direction = 'inbound'`,
      [peerId],
    );
  }

  public revokeLanWrite(peerId: string): void {
    dbRun(
      this.db,
      `UPDATE lan_peers SET write_allowed = 0 WHERE peer_id = ? AND direction = 'inbound'`,
      [peerId],
    );
  }

  public removeLanPeer(peerId: string): void {
    dbRun(this.db, `DELETE FROM lan_peers WHERE peer_id = ?`, [peerId]);
    dbRun(this.db, `DELETE FROM federation_known_namespaces WHERE peer_id = ?`, [peerId]);
  }

  public getLanPeerByPubkey(pubkey: Uint8Array): LanPeerRow | undefined {
    const row = this.db
      .query(`SELECT * FROM lan_peers WHERE peer_pubkey = ?`)
      .get(Buffer.from(pubkey)) as LanPeerRow | null;
    return row ?? undefined;
  }

  close(): void {
    try {
      dbRun(this.db, "PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* ignore */
    }
    this.db.close();
  }

  getAuditSummary(): {
    byOutcome: Record<string, number>;
    byService: Record<string, number>;
    total: number;
  } {
    const byOutcome: Record<string, number> = {};
    const byService: Record<string, number> = {};
    let total = 0;
    const outcomes = this.db
      .query("SELECT hitl_status AS outcome, COUNT(*) AS c FROM audit_log GROUP BY hitl_status")
      .all() as { outcome: string; c: number }[];
    for (const r of outcomes) {
      byOutcome[r.outcome] = r.c;
      total += r.c;
    }
    const services = this.db
      .query("SELECT action_type, COUNT(*) AS c FROM audit_log GROUP BY action_type")
      .all() as { action_type: string; c: number }[];
    for (const r of services) {
      const prefix = r.action_type.split(".")[0] ?? r.action_type;
      byService[prefix] = (byService[prefix] ?? 0) + r.c;
    }
    return { byOutcome, byService, total };
  }

  listAudit(limit: number): AuditEntry[] {
    const capped = Math.min(1000, Math.max(1, Math.floor(limit)));
    const rows = this.db
      .query(
        `SELECT id, action_type, hitl_status, action_json, timestamp
         FROM audit_log
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(capped) as Array<{
      id: number;
      action_type: string;
      hitl_status: string;
      action_json: string;
      timestamp: number;
    }>;

    return rows.map((r) => {
      const status = r.hitl_status;
      if (status !== "approved" && status !== "rejected" && status !== "not_required") {
        throw new Error("Corrupt audit_log row: invalid hitl_status");
      }
      return {
        id: r.id,
        actionType: r.action_type,
        hitlStatus: status,
        actionJson: r.action_json,
        timestamp: r.timestamp,
      };
    });
  }
}
