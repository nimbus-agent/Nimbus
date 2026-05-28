/**
 * Pure mapping from a Stack Overflow for Teams `GET /v3/teams/<team>/questions`
 * list element to the {@link upsertIndexedItemForSync} row shape. Lives
 * separately from `stackoverflow-sync.ts` so the REST path and the indexing
 * path can be tested independently.
 *
 * Emits `service = "stackoverflow", type = "question"` rows — a single item
 * type. `external_id = String(<question id>)`. The conceptual item identity is
 * `stackoverflow:question`; the `item.id` ends up `stackoverflow:<id>`. SO ids
 * are NUMBERS, so the row is skipped when `id` is missing/non-numeric (mirroring
 * Raindrop's `_id` numeric-skip).
 *
 * IMPORTANT: Stack Overflow for Teams' `creationDate`, `lastActivityDate`, and
 * `lastEditDate` are ISO-8601 STRINGS (e.g. `"2024-03-01T12:00:00.000Z"`), like
 * Readwise's / Raindrop's timestamps and UNLIKE the epoch-ms / epoch-seconds
 * number APIs. Parse them to epoch-ms with the local {@link parseIsoMs} — never
 * pass the ISO string through verbatim, and never treat it as epoch seconds.
 *
 * v3 `tags` may be objects `{ name }` OR plain strings; only the tag NAMES are
 * stored (as a string array), tolerating both shapes (mirroring Readwise's
 * `tagNames` tolerance). The question body is HTML; it is stripped to plain
 * text for the body preview (a simple tag-strip + whitespace collapse, no
 * dependency). The per-question `webUrl` is the canonical URL.
 *
 * A question body is genuinely prose, but the type is deliberately NOT added to
 * `PROSE_HEAVY_TYPES` (batch default + the routing-skill "default to omitting"
 * rule — promoting it would send every hybrid-mode user's whole Q&A corpus
 * through OpenAI on the next embed pass). It stays on local MiniLM embeddings;
 * promotion to `PROSE_HEAVY_TYPES` is a documented follow-up candidate.
 */

import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface StackOverflowMappingContext {
  readonly syncedAt: number;
}

export interface StackOverflowMappedRow {
  readonly service: "stackoverflow";
  readonly type: "question";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

/** ISO-8601 string → epoch ms, or null for non-strings / unparseable input. */
function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

/**
 * Strip HTML tags from a string to plain text. Removes `<...>` runs, collapses
 * runs of whitespace to a single space, and trims. Returns `""` for non-strings
 * or empty results. Intentionally simple — no HTML-entity decoding, no
 * dependency.
 */
function stripHtml(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tag NAMES from a Stack Overflow `tags: [...]` array. v3 tags may be objects
 * `{ name }` OR plain strings — both are tolerated; non-object / non-string and
 * nameless entries are skipped. Non-array input yields `[]`.
 */
export function tagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const names: string[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      if (t !== "") {
        names.push(t);
      }
      continue;
    }
    const row = asRecord(t);
    if (row === undefined) {
      continue;
    }
    const name = stringField(row, "name");
    if (name !== undefined && name !== "") {
      names.push(name);
    }
  }
  return names;
}

export function mapStackOverflowQuestionToItem(
  raw: unknown,
  ctx: StackOverflowMappingContext,
): StackOverflowMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  // `id` is a number — stringify for external_id; skip the row if missing.
  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  const id = String(idNum);

  const rawTitle = stringField(row, "title") ?? null;
  const bodyHtml = stringField(row, "body") ?? null;
  const bodyMarkdown = stringField(row, "bodyMarkdown") ?? null;
  const webUrl = stringField(row, "webUrl") ?? null;
  const score = numberField(row, "score") ?? null;
  const viewCount = numberField(row, "viewCount") ?? null;
  const answerCount = numberField(row, "answerCount") ?? null;
  const isAnswered = typeof row["isAnswered"] === "boolean" ? row["isAnswered"] : null;
  const tags = tagNames(row["tags"]);

  // owner_id / owner_name from the nested `owner` object, defensive.
  const owner = asRecord(row["owner"]);
  const ownerId = owner !== undefined ? (numberField(owner, "id") ?? null) : null;
  const ownerName = owner !== undefined ? (stringField(owner, "name") ?? null) : null;

  const creationDate = parseIsoMs(row["creationDate"]);
  const lastActivityDate = parseIsoMs(row["lastActivityDate"]);
  const lastEditDate = parseIsoMs(row["lastEditDate"]);

  // canonical/url: the per-question webUrl when a non-empty string, else null.
  const canonicalUrl = webUrl !== null && webUrl !== "" ? webUrl : null;

  // title: the trimmed question title when present, else `Question <id>`.
  const trimmedTitle = rawTitle !== null ? rawTitle.trim() : "";
  const title = trimmedTitle !== "" ? trimmedTitle : `Question ${id}`;

  // bodyPreview: the HTML-stripped body, else the markdown body, else a tag
  // summary, else the title.
  const strippedBody = stripHtml(bodyHtml);
  const tagSummary = tags.join(", ");
  const bodyPreview =
    strippedBody !== ""
      ? strippedBody
      : bodyMarkdown !== null && bodyMarkdown !== ""
        ? bodyMarkdown
        : tagSummary !== ""
          ? tagSummary
          : title;

  const modifiedAt = lastActivityDate ?? lastEditDate ?? creationDate ?? ctx.syncedAt;

  const metadata: Record<string, unknown> = {
    question_id: id,
    title: rawTitle,
    tags,
    score,
    view_count: viewCount,
    answer_count: answerCount,
    is_answered: isAnswered,
    owner_id: ownerId,
    owner_name: ownerName,
    creation_date: creationDate,
    last_activity_date: lastActivityDate,
    last_edit_date: lastEditDate,
    canonical_url: canonicalUrl,
  };

  return {
    service: "stackoverflow",
    type: "question",
    externalId: id,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
