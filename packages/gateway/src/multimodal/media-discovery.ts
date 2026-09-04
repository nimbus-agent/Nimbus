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
  type MediaItemTypePair,
  MIME_KEYED_SERVICES,
  MIME_PATTERNS_FOR_MODALITY,
  mediaItemTypePairsForModality,
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

export interface ModalityPredicate {
  readonly clause: string;
  readonly params: readonly (string | number)[];
}

/**
 * Builds the two-arm modality predicate, or `null` when NEITHER arm has anything to admit — a
 * caller must treat `null` as "return no candidates", never as "emit an empty WHERE".
 *
 * `src.type IN ()` and an empty `OR`-list are both SQLite syntax errors, so an empty arm is
 * dropped from the clause entirely rather than emitted empty; symmetrically, a caller must NOT
 * bail out just because ONE arm is empty — `pairs` alone going empty (a modality no LOCAL type
 * carries) must not short-circuit discovery while the mime arm can still return a page. That
 * premise ("no local pairs means nothing to select") held before the mime arm existed and does
 * not anymore (fix round 2).
 *
 * Exported and pure so the empty-`pairs` case is directly testable: today's registry always has a
 * local pair for both modalities, so this case cannot be reached by driving `findCandidates`
 * itself — it stands in for a future registry state (e.g. filesystem media indexing dropped while
 * `google_photos` still covers "image" via mime), and pinning it here does not require faking
 * database rows or the registry.
 */
export function buildModalityPredicate(
  pairs: readonly MediaItemTypePair[],
  mimeServices: readonly string[],
  mimePatterns: readonly string[],
): ModalityPredicate | null {
  const arms: string[] = [];
  const params: (string | number)[] = [];

  // Arm 1: non-mime-keyed services, matched by the EXACT (service, type) PAIR the JS check uses
  // (`modalityForItem`'s ITEM_TYPE_MODALITY branch) — never by type alone. A bare `src.type IN
  // (...)` would match that type across every OTHER service too (a future `zoom:recording` pair
  // catching an unrelated service's `type: "recording"`), which the JS loop would then drop for
  // lacking a registered pair, under-filling the page (fix round 2).
  if (pairs.length > 0) {
    arms.push(`(${pairs.map(() => "(src.service = ? AND src.type = ?)").join(" OR ")})`);
    for (const pair of pairs) params.push(pair.service, pair.type);
  }

  // Arm 2: a mime-keyed service is admitted ONLY when its declared mime matches the requested
  // modality. Filtering this in JS instead would under-fill the SQL page, and `media-pass.ts`
  // reads a short page as end-of-queue and clears the cursor — silently truncating the pass
  // (spec § 17.1).
  if (mimeServices.length > 0) {
    arms.push(
      `(src.service IN (${mimeServices.map(() => "?").join(", ")})
        AND (${mimePatterns.map(() => "json_extract(src.metadata, '$.mimeType') LIKE ?").join(" OR ")}))`,
    );
    params.push(...mimeServices, ...mimePatterns);
  }

  if (arms.length === 0) return null;
  return { clause: `(${arms.join(" OR ")})`, params };
}

export function findCandidates(db: Database, opts: DiscoveryOptions): MediaCandidate[] {
  // Filtering modality in SQL, not just in the JS loop below: LIMIT is applied by SQLite, so a
  // JS-only modality filter after the fetch would silently under-fill the page whenever
  // other-modality rows sort first (fix round 1).
  const pairs = mediaItemTypePairsForModality(opts.modality);
  const mimeServices = [...MIME_KEYED_SERVICES];
  const mimePatterns =
    opts.modality === undefined
      ? [...MIME_PATTERNS_FOR_MODALITY.image, ...MIME_PATTERNS_FOR_MODALITY.av]
      : MIME_PATTERNS_FOR_MODALITY[opts.modality];

  const predicate = buildModalityPredicate(pairs, mimeServices, mimePatterns);
  if (predicate === null) return [];

  const wheres: string[] = [
    // No understanding row, OR one at an older version.
    `(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)`,
    predicate.clause,
  ];
  const params: (string | number)[] = [UNDERSTANDING_VERSION, ...predicate.params];

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
