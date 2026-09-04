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
  MIME_KEYED_SERVICES,
  MIME_PATTERNS_FOR_MODALITY,
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
  readonly external_id: string;
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
    // No understanding row, OR one at an older version.
    `(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)`,
  ];
  const params: (string | number)[] = [UNDERSTANDING_VERSION];

  const mimeServices = [...MIME_KEYED_SERVICES];
  const mimePatterns =
    opts.modality === undefined
      ? [...MIME_PATTERNS_FOR_MODALITY.image, ...MIME_PATTERNS_FOR_MODALITY.av]
      : MIME_PATTERNS_FOR_MODALITY[opts.modality];

  // A mime-keyed service is admitted ONLY when its declared mime matches the requested modality.
  // Filtering this in JS instead would under-fill the SQL page, and `media-pass.ts` reads a short
  // page as end-of-queue and clears the cursor — silently truncating the pass (spec § 17.1).
  wheres.push(
    `(
       (src.service NOT IN (${mimeServices.map(() => "?").join(", ")})
        AND src.type IN (${mediaTypes.map(() => "?").join(", ")}))
       OR
       (src.service IN (${mimeServices.map(() => "?").join(", ")})
        AND (${mimePatterns.map(() => "json_extract(src.metadata, '$.mimeType') LIKE ?").join(" OR ")}))
     )`,
  );
  params.push(...mimeServices, ...mediaTypes, ...mimeServices, ...mimePatterns);

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
      `SELECT src.id, src.service, src.external_id, src.type, src.title, src.url, src.metadata
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
    const meta = parseMetadata(row.metadata);
    const mime = stringOrNull(meta["mimeType"]);
    const modality = modalityForItem(row.service, row.type, mime);
    if (modality === undefined) continue;
    if (opts.modality !== undefined && modality !== opts.modality) continue;

    out.push({
      itemId: row.id,
      service: row.service,
      externalId: row.external_id,
      type: row.type,
      title: row.title,
      url: row.url,
      modality,
      sourcePath: stringOrNull(meta["path"]),
      sourceMime: mime,
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
