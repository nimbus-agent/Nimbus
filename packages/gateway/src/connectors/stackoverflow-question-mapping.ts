import type { MappedRow } from "./mapped-row.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface StackOverflowMappingContext {
  readonly syncedAt: number;
}

export type StackOverflowMappedRow = MappedRow<"stackoverflow", "question">;

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function stripHtml(raw: unknown): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw
    .replace(/<[^<>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function deriveStackOverflowBodyPreview(args: {
  strippedBody: string;
  bodyMarkdown: string | null;
  tagSummary: string;
  title: string;
}): string {
  const { strippedBody, bodyMarkdown, tagSummary, title } = args;
  if (strippedBody !== "") {
    return strippedBody;
  }
  if (bodyMarkdown !== null && bodyMarkdown !== "") {
    return bodyMarkdown;
  }
  if (tagSummary !== "") {
    return tagSummary;
  }
  return title;
}

export function mapStackOverflowQuestionToItem(
  raw: unknown,
  ctx: StackOverflowMappingContext,
): StackOverflowMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

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

  const owner = asRecord(row["owner"]);
  const ownerId = owner === undefined ? null : (numberField(owner, "id") ?? null);
  const ownerName = owner === undefined ? null : (stringField(owner, "name") ?? null);

  const creationDate = parseIsoMs(row["creationDate"]);
  const lastActivityDate = parseIsoMs(row["lastActivityDate"]);
  const lastEditDate = parseIsoMs(row["lastEditDate"]);

  const canonicalUrl = webUrl !== null && webUrl !== "" ? webUrl : null;

  const trimmedTitle = rawTitle === null ? "" : rawTitle.trim();
  const title = trimmedTitle === "" ? `Question ${id}` : trimmedTitle;

  const strippedBody = stripHtml(bodyHtml);
  const tagSummary = tags.join(", ");
  const bodyPreview = deriveStackOverflowBodyPreview({
    strippedBody,
    bodyMarkdown,
    tagSummary,
    title,
  });

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
