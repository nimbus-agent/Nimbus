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
  /**
   * The vendor named by `[multimodal] remote_vlm`, when one is configured.
   *
   * ABSENT means the whole grant clause is omitted and no parameter is bound — an install with no
   * remote arm runs exactly the query it ran before PR 4, at the same cost. Present, it re-offers
   * items whose existing understanding is LOCAL and which carry an active grant for THIS vendor.
   */
  readonly remoteVendor?: string | undefined;
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
 * An empty `OR`-list and an empty `IN (...)` are both SQLite syntax errors, so an empty arm is
 * dropped from the clause entirely rather than emitted empty. (Arm 1 has been OR'd `(service,
 * type)` equalities since fix round 2 — `src.type IN ()` was the hazard when it was type-keyed and
 * is named here only because the shape of the hazard is unchanged: an arm with nothing to admit
 * must not be emitted at all.) symmetrically, a caller must NOT
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
  // (spec § 17.1). Guarded on BOTH lists, not just `mimeServices`: an empty `mimePatterns` with a
  // non-empty `mimeServices` would otherwise emit `AND ()`, a SQLite syntax error — the exact
  // failure this function's own contract (above) promises never happens (fix round 3).
  if (mimeServices.length > 0 && mimePatterns.length > 0) {
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

  // No understanding row, OR one at an older version, OR one that is LOCAL while an active grant
  // names the configured remote vendor (spec § 19.1).
  //
  // Derived rather than STORED, deliberately: the rejected alternative wrote
  // `understandingVersion = 0` at grant time, which re-offers the item on every pass until
  // something understands it — so the moment the remote arm cannot run (vendor disabled, key
  // rotated out of the Vault, org policy flipped), the item is re-offered, refused, and
  // re-offered again forever. That is the livelock PR 3 hit with the pass cursor. A predicate
  // self-corrects the instant `remote_vlm` changes.
  //
  // COALESCE alone does not guard `json_extract` against malformed JSON: SQLite RAISES before
  // COALESCE ever sees a value to substitute (COALESCE only replaces NULL results, never a thrown
  // error), and OR does not reliably short-circuit around it either — a row with an understanding
  // row present (`u.id IS NOT NULL`) still forces evaluation of the right-hand json_extract. A
  // `json_valid` guard is what actually stops a derived row whose metadata does not round-trip
  // from blowing up discovery for every artifact; wrapping json_extract's own extraction inside a
  // CASE keeps a valid-JSON row's behaviour byte-for-byte identical to a bare json_extract.
  const safeExtract = (path: string) =>
    `CASE WHEN json_valid(u.metadata) THEN json_extract(u.metadata, '${path}') END`;
  const versionArm = `(u.id IS NULL OR COALESCE(${safeExtract("$.understandingVersion")}, -1) < ?)`;
  const wheres: string[] = [];
  const params: (string | number)[] = [];

  if (opts.remoteVendor === undefined) {
    wheres.push(versionArm);
    params.push(UNDERSTANDING_VERSION);
  } else {
    wheres.push(
      `(${versionArm} OR (
          COALESCE(${safeExtract("$.isLocal")}, 0) IN (1, 'true')
          AND EXISTS (
            SELECT 1 FROM media_grant AS g
             WHERE g.item_id = src.id
               AND g.revoked_at IS NULL
               AND g.modality = 'image'
               AND g.model_vendor = ?
          )
        ))`,
    );
    params.push(UNDERSTANDING_VERSION, opts.remoteVendor);
  }
  wheres.push(predicate.clause);
  params.push(...predicate.params);

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
