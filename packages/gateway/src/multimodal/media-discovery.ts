/**
 * Selects the media items that still need understanding (spec § 8).
 *
 * "Needs understanding" is a VERSION comparison, not an existence check: an item understood at an
 * older `understandingVersion` must be re-offered, which is what makes a model upgrade a re-run
 * rather than a migration (spec § 4.1).
 *
 * SQL is bound-parameter only (I9). `json_extract` on `metadata` is safe here because every row
 * this query can reach was written by `upsertIndexedItem`, which JSON-serialises metadata itself —
 * the column is never free-form text.
 */
import type { Database } from "bun:sqlite";
import {
  mediaItemTypesForModality,
  mediaSourceBytes,
  modalityForItem,
} from "./media-source-registry.ts";
import { type MediaCandidate, type MediaModality, UNDERSTANDING_VERSION } from "./media-types.ts";

export interface DiscoveryOptions {
  readonly service?: string;
  readonly modality?: MediaModality;
  readonly sinceMs?: number;
  readonly limit: number;
  /** Resume cursor: return only ids strictly greater than this. */
  readonly afterItemId?: string;
}

interface CandidateRow {
  readonly id: string;
  readonly service: string;
  readonly type: string;
  readonly title: string;
  readonly url: string | null;
  readonly metadata: string | null;
}

export function findCandidates(db: Database, opts: DiscoveryOptions): MediaCandidate[] {
  // Filtering modality in SQL, not just in the JS loop below: LIMIT is applied by SQLite, so a
  // JS-only modality filter after the fetch would silently under-fill the page whenever
  // other-modality rows sort first (fix round 1).
  const mediaTypes = mediaItemTypesForModality(opts.modality);
  if (mediaTypes.length === 0) return [];

  const wheres: string[] = [
    `src.type IN (${mediaTypes.map(() => "?").join(", ")})`,
    // No understanding row, OR one at an older version.
    `(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)`,
  ];
  const params: (string | number)[] = [...mediaTypes, UNDERSTANDING_VERSION];

  if (opts.service !== undefined) {
    wheres.push("src.service = ?");
    params.push(opts.service);
  }
  if (opts.sinceMs !== undefined) {
    wheres.push("src.modified_at >= ?");
    params.push(opts.sinceMs);
  }
  if (opts.afterItemId !== undefined) {
    wheres.push("src.id > ?");
    params.push(opts.afterItemId);
  }

  params.push(opts.limit);

  const rows = db
    .query<CandidateRow, (string | number)[]>(
      `SELECT src.id, src.service, src.type, src.title, src.url, src.metadata
         FROM item AS src
         LEFT JOIN item AS u
           ON u.service = 'nimbus'
          AND u.external_id = src.id || ':understanding'
        WHERE ${wheres.join(" AND ")}
        ORDER BY src.id
        LIMIT ?`,
    )
    .all(...params);

  const out: MediaCandidate[] = [];
  for (const row of rows) {
    const modality = modalityForItem(row.service, row.type);
    if (modality === undefined) continue;
    if (opts.modality !== undefined && modality !== opts.modality) continue;

    const meta = parseMetadata(row.metadata);
    out.push({
      itemId: row.id,
      service: row.service,
      type: row.type,
      title: row.title,
      url: row.url,
      modality,
      sourcePath: stringOrNull(meta["path"]),
      sourceMime: stringOrNull(meta["mimeType"]),
      sourceBytes: mediaSourceBytes(row.service, meta),
    });
  }
  return out;
}

function parseMetadata(raw: string | null): Record<string, unknown> {
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
