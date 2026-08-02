import type { Database } from "bun:sqlite";

import { vectorSearchChunksDual } from "./dual-search.ts";
import type { HybridIndexedItem, HybridSearchOptions, HybridSearchResult } from "./hybrid-types.ts";
import type { VectorChunkHit } from "./vec-store.ts";

export function rrfTerm(rank: number, k: number): number {
  return 1 / (k + rank);
}

export function bestVectorRanksByItem(hits: readonly { itemId: string }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < hits.length; i++) {
    const id = hits[i]?.itemId;
    if (id === undefined) {
      continue;
    }
    const r = i + 1;
    const prev = m.get(id);
    if (prev === undefined || r < prev) {
      m.set(id, r);
    }
  }
  return m;
}

export function chunkContextLines(
  db: Database,
  itemId: string,
  model: string,
  centerIndex: number,
  contextChunks: number,
): string[] {
  const n = Math.min(8, Math.max(0, Math.floor(contextChunks)));
  if (n === 0) {
    return [];
  }
  const low = Math.max(0, centerIndex - n);
  const high = centerIndex + n;
  const rows = db
    .query(
      `SELECT chunk_text FROM embedding_chunk
       WHERE item_id = ? AND model = ? AND chunk_index >= ? AND chunk_index <= ?
       ORDER BY chunk_index ASC`,
    )
    .all(itemId, model, low, high) as Array<{ chunk_text: string }>;
  return rows.map((r) => r.chunk_text);
}

export function ftsMatchQuery(name: string): string {
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
      return `(title : "${escaped}"* OR body : "${escaped}"*)`;
    })
    .join(" AND ");
}

type Bm25Hit = { item: HybridIndexedItem; rank: number };

export function loadBm25Hits(
  db: Database,
  fts: string,
  limit: number,
  serviceFilter: string | undefined,
  opts: HybridSearchOptions,
): Bm25Hit[] {
  const params: Array<string | number> = [];
  let whereExtra = "";
  if (serviceFilter !== undefined) {
    whereExtra += " AND i.service = ?";
    params.push(serviceFilter);
  }
  if (opts.itemType !== undefined && opts.itemType !== "") {
    whereExtra += " AND i.type = ?";
    params.push(opts.itemType);
  }
  if (opts.since !== undefined && opts.since > 0) {
    whereExtra += " AND i.modified_at >= ?";
    params.push(opts.since);
  }
  const cap = Math.min(500, limit * 15);
  const sql = `
      SELECT i.id AS id, i.service AS service, i.type AS type, i.external_id AS external_id,
             i.title AS title, i.body_preview AS body_preview, i.url AS url, i.canonical_url AS canonical_url,
             i.modified_at AS modified_at, i.author_id AS author_id, i.metadata AS metadata,
             i.synced_at AS synced_at, i.pinned AS pinned
      FROM item i
      INNER JOIN item_fts ON i.rowid = item_fts.rowid
      WHERE item_fts MATCH ? ${whereExtra}
      ORDER BY rank
      LIMIT ?
    `;
  const rows = db.query(sql).all(fts, ...params, cap) as HybridIndexedItem[];
  const bm25Hits: Bm25Hit[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row !== undefined) {
      bm25Hits.push({ item: row, rank: i + 1 });
    }
  }
  return bm25Hits;
}

export function runVectorSearch(
  db: Database,
  opts: HybridSearchOptions,
  limit: number,
  serviceFilter: string | undefined,
  nameQ: string,
): VectorChunkHit[] {
  const semantic = opts.semantic ?? true;
  if (!semantic || nameQ.length === 0) {
    return [];
  }
  const has384 = opts.queryEmbedding !== undefined;
  const has1536 = opts.queryEmbedding1536 !== undefined;
  if (!has384 && !has1536) {
    return [];
  }
  const dualOpts: {
    queryEmbedding384?: Float32Array;
    queryEmbedding1536?: Float32Array;
    model384?: string;
    model1536?: string;
    limit: number;
    service?: string;
    itemType?: string;
    since?: number;
  } = { limit: Math.min(500, limit * 25) };
  if (opts.queryEmbedding !== undefined) {
    dualOpts.queryEmbedding384 = opts.queryEmbedding;
    dualOpts.model384 = opts.embeddingModel;
  }
  if (opts.queryEmbedding1536 !== undefined && opts.embeddingModel1536 !== undefined) {
    dualOpts.queryEmbedding1536 = opts.queryEmbedding1536;
    dualOpts.model1536 = opts.embeddingModel1536;
  }
  if (serviceFilter !== undefined) dualOpts.service = serviceFilter;
  if (opts.itemType !== undefined && opts.itemType !== "") dualOpts.itemType = opts.itemType;
  if (opts.since !== undefined && opts.since > 0) dualOpts.since = opts.since;
  return vectorSearchChunksDual(db, dualOpts);
}

export function dedupeHybridByCanonicalUrl(results: HybridSearchResult[]): HybridSearchResult[] {
  const out: HybridSearchResult[] = [];
  const canonicalToIdx = new Map<string, number>();
  for (const r of results) {
    const canon = r.item.canonical_url;
    if (canon === null || canon === undefined || canon.trim() === "") {
      out.push(r);
      continue;
    }
    const c = canon.trim();
    const idx = canonicalToIdx.get(c);
    if (idx === undefined) {
      canonicalToIdx.set(c, out.length);
      out.push(r);
      continue;
    }
    const prev = out[idx];
    if (prev === undefined) {
      out.push(r);
      continue;
    }
    const dups = [...(prev.duplicates ?? []), r.item.service];
    out[idx] = { ...prev, duplicates: dups };
  }
  return out;
}

const HYBRID_ITEM_ROW_SQL = `SELECT i.id AS id, i.service AS service, i.type AS type, i.external_id AS external_id,
            i.title AS title, i.body_preview AS body_preview, i.url AS url, i.canonical_url AS canonical_url,
            i.modified_at AS modified_at, i.author_id AS author_id, i.metadata AS metadata,
            i.synced_at AS synced_at, i.pinned AS pinned
            FROM item i WHERE i.id = ?`;

export type HybridScoringParams = {
  db: Database;
  opts: HybridSearchOptions;
  k: number;
  wB: number;
  wV: number;
  contextN: number;
};

type HybridScoreWork = {
  params: HybridScoringParams;
  bm25Hits: Bm25Hit[];
  bm25RankById: Map<string, number>;
  vecBestRank: Map<string, number>;
  winningChunkByItem: Map<string, VectorChunkHit>;
  itemIds: string[];
};

function bm25RankMap(hits: Bm25Hit[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const h of hits) {
    m.set(h.item.id, h.rank);
  }
  return m;
}

function firstChunkByItem(vecHitsRaw: VectorChunkHit[]): Map<string, VectorChunkHit> {
  const m = new Map<string, VectorChunkHit>();
  for (const h of vecHitsRaw) {
    if (m.has(h.itemId)) {
      continue;
    }
    m.set(h.itemId, h);
  }
  return m;
}

function hybridItemIdUnion(bm25Hits: Bm25Hit[], vecBestRank: Map<string, number>): string[] {
  const ids = new Set<string>();
  for (const h of bm25Hits) {
    ids.add(h.item.id);
  }
  for (const id of vecBestRank.keys()) {
    ids.add(id);
  }
  return [...ids];
}

function sortHybridResultsByRrf(scored: HybridSearchResult[]): void {
  scored.sort((a, b) => {
    if (b.rrfScore !== a.rrfScore) {
      return b.rrfScore - a.rrfScore;
    }
    return b.item.modified_at - a.item.modified_at;
  });
}

function semanticSnippetForHit(
  work: HybridScoreWork,
  itemId: string,
  win: VectorChunkHit | undefined,
): string | undefined {
  if (win === undefined) {
    return undefined;
  }
  const { db, opts, contextN } = work.params;
  const parts =
    contextN > 0
      ? chunkContextLines(db, itemId, opts.embeddingModel, win.chunkIndex, contextN)
      : [win.chunkText];
  return parts.join("\n---\n");
}

function tryBuildHybridHit(itemId: string, work: HybridScoreWork): HybridSearchResult | null {
  const { db, k, wB, wV } = work.params;
  const rb = work.bm25RankById.get(itemId);
  const rv = work.vecBestRank.get(itemId);
  const rrfB = rb === undefined ? 0 : wB * rrfTerm(rb, k);
  const rrfV = rv === undefined ? 0 : wV * rrfTerm(rv, k);
  const rrfScore = rrfB + rrfV;
  if (rrfScore <= 0) {
    return null;
  }
  const row =
    work.bm25Hits.find((h) => h.item.id === itemId)?.item ??
    (db.query(HYBRID_ITEM_ROW_SQL).get(itemId) as HybridIndexedItem | null);
  if (row === null || row === undefined) {
    return null;
  }
  const snippet = semanticSnippetForHit(work, itemId, work.winningChunkByItem.get(itemId));
  const hit: HybridSearchResult = {
    item: row,
    bm25Rank: rb ?? null,
    vectorRank: rv ?? null,
    rrfScore,
  };
  if (snippet !== undefined) {
    hit.semanticSnippet = snippet;
  }
  return hit;
}

export function scoreHybridItems(
  bm25Hits: Bm25Hit[],
  vecHitsRaw: VectorChunkHit[],
  scoring: HybridScoringParams,
): HybridSearchResult[] {
  const bm25RankById = bm25RankMap(bm25Hits);
  const vecBestRank = bestVectorRanksByItem(vecHitsRaw);
  const winningChunkByItem = firstChunkByItem(vecHitsRaw);
  const itemIds = hybridItemIdUnion(bm25Hits, vecBestRank);

  const work: HybridScoreWork = {
    params: scoring,
    bm25Hits,
    bm25RankById,
    vecBestRank,
    winningChunkByItem,
    itemIds,
  };

  const scored: HybridSearchResult[] = [];
  for (const id of itemIds) {
    const hit = tryBuildHybridHit(id, work);
    if (hit !== null) {
      scored.push(hit);
    }
  }
  sortHybridResultsByRrf(scored);
  return scored;
}
