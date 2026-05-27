/**
 * Pure mapping from a Lever `GET /v1/postings` list element to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `lever-sync.ts` so the REST path and the indexing path can be tested
 * independently.
 *
 * Emits `service = "lever", type = "posting"` rows — a single item type. The
 * conceptual item identity is `lever:posting`; the `item.id` ends up
 * `lever:<id>`. `external_id = String(<posting id>)`. Lever posting ids are
 * UUID strings (e.g. `f2f01e16-27f8-4711-a728-e7c5e8c2d4c4`), so any non-empty
 * STRING id is accepted (the row is skipped only when the id is missing/empty —
 * NOT required to be numeric, unlike Raindrop's `_id`). A posting is short (a
 * title plus a category summary), so it stays on local MiniLM embeddings — NOT
 * added to `PROSE_HEAVY_TYPES` (avoids surprise OpenAI spend on the whole
 * postings corpus).
 *
 * IMPORTANT: Lever's `createdAt` and `updatedAt` are epoch MILLISECONDS
 * (numbers), like Vercel's `created` and UNLIKE the ISO-string APIs
 * (Raindrop / Readwise / Mercury) and the epoch-SECONDS APIs (Stripe /
 * Intercom). Pass them through VERBATIM via `numberField` — never `Date.parse`,
 * never ×1000. A `0`/missing value yields null.
 *
 * The `categories` sub-object (`team` / `department` / `location` /
 * `commitment` / `level`) is flattened to the top level via defensive
 * {@link asRecord} access. The `tags` array is a list of plain strings; the
 * string array is stored verbatim (filtering to strings, tolerating a
 * non-array). The `hostedUrl` is the canonical URL.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface LeverMappingContext {
  readonly syncedAt: number;
}

export interface LeverMappedRow {
  readonly service: "lever";
  readonly type: "posting";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/**
 * An epoch-millisecond timestamp field, passed through VERBATIM (no parse, no
 * ×1000). A non-number, a non-finite value, or `0` (a real Lever timestamp is
 * never 0) yields null.
 */
function epochMs(row: Record<string, unknown>, key: string): number | null {
  const v = numberField(row, key);
  return v === undefined || v === 0 ? null : v;
}

/**
 * Tag strings from a Lever `tags: ["a", "b"]` array. Non-array input and
 * non-string entries are tolerated (skipped).
 */
export function tagStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      names.push(t);
    }
  }
  return names;
}

/**
 * The requisition code: prefer the scalar `reqCode`, else the first string of
 * the `requisitionCodes` array (defensive — Lever has carried both shapes).
 */
function reqCode(row: Record<string, unknown>): string | null {
  const direct = stringField(row, "reqCode");
  if (direct !== undefined && direct !== "") {
    return direct;
  }
  const list = row["requisitionCodes"];
  if (Array.isArray(list)) {
    for (const c of list) {
      if (typeof c === "string" && c !== "") {
        return c;
      }
    }
  }
  return null;
}

export function mapLeverPostingToItem(
  raw: unknown,
  ctx: LeverMappingContext,
): LeverMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // Lever ids are UUID strings — accept any non-empty string id; skip the row
  // when the id is missing/empty (do NOT require numeric).
  const idRaw = stringField(row, "id");
  if (idRaw === undefined || idRaw === "") {
    return null;
  }
  const id = String(idRaw);

  const text = stringField(row, "text") ?? null;
  const state = stringField(row, "state") ?? null;

  const categories = asRecord(row["categories"]) ?? {};
  const team = stringField(categories, "team") ?? null;
  const department = stringField(categories, "department") ?? null;
  const location = stringField(categories, "location") ?? null;
  const commitment = stringField(categories, "commitment") ?? null;
  const level = stringField(categories, "level") ?? null;

  const tags = tagStrings(row["tags"]);

  const hostedUrl = stringField(row, "hostedUrl") ?? null;
  const applyUrl = stringField(row, "applyUrl") ?? null;
  const urls = asRecord(row["urls"]) ?? {};
  const urlsShow = stringField(urls, "show") ?? null;

  // Lever `createdAt` / `updatedAt` are epoch ms — pass through VERBATIM, no
  // Date.parse, no ×1000. A `0` or missing value yields null (a real Lever
  // timestamp is never 0).
  const createdAt = epochMs(row, "createdAt");
  const updatedAt = epochMs(row, "updatedAt");

  // canonical/url: hostedUrl, else urls.show, else applyUrl, else null.
  const canonicalUrl =
    hostedUrl !== null && hostedUrl !== ""
      ? hostedUrl
      : urlsShow !== null && urlsShow !== ""
        ? urlsShow
        : applyUrl !== null && applyUrl !== ""
          ? applyUrl
          : null;

  // title: the posting text (trimmed) when present, else `Posting <id>`.
  const trimmedText = text !== null ? text.trim() : "";
  const titleText = trimmedText !== "" ? trimmedText : `Posting ${id}`;

  // bodyPreview: a category summary joining the present categories fields, else
  // the state, else the title.
  const categorySummary = [team, department, location, commitment, level]
    .filter((c): c is string => c !== null && c !== "")
    .join(" — ");
  const bodyPreview =
    categorySummary !== "" ? categorySummary : state !== null && state !== "" ? state : titleText;

  const modifiedAt = updatedAt ?? createdAt ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    posting_id: id,
    text,
    state,
    team,
    department,
    location,
    commitment,
    level,
    tags,
    hosted_url: hostedUrl,
    apply_url: applyUrl,
    req_code: reqCode(row),
    created_at: createdAt,
    updated_at: updatedAt,
    canonical_url: canonicalUrl,
  };

  return {
    service: "lever",
    type: "posting",
    externalId: id,
    title: titleText,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
