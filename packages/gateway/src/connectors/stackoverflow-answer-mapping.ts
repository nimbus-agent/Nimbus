import { plainTextFromHtml } from "../string/html-plain-text.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

export interface StackOverflowAnswerMappingContext {
  readonly syncedAt: number;
  /**
   * The id of the question whose answers were requested. Answers are only reachable per
   * question (`/questions/{id}/answers`), so the sync always knows it; a row's own `questionId`
   * still wins when present.
   */
  readonly questionId: string;
  /** The parent question's title, when the sync has it; used to give the answer a searchable title. */
  readonly questionTitle: string | null;
}

/**
 * Shaped like {@link import("./mapped-row.ts").MappedRow} but with `body` (declared-full) in
 * place of `bodyPreview`, so the store's own body-depth setting and length cap, not this mapper,
 * decide how much answer text is kept.
 */
export interface StackOverflowAnswerMappedRow {
  readonly service: "stackoverflow";
  readonly type: "answer";
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly url: string | null;
  readonly canonicalUrl: string | null;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

function parseIsoMs(v: unknown): number | null {
  return typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;
}

function nonEmpty(v: string | undefined): string | null {
  return v !== undefined && v !== "" ? v : null;
}

/**
 * An item's primary key is `<service>:<externalId>` and does not include the type, and the
 * question mapper uses the bare numeric id. The Teams API reference does not say that question
 * and answer ids can never be equal, so the answer id is namespaced: an answer can never
 * overwrite a question that happens to share its number.
 */
export function stackOverflowAnswerExternalId(answerId: string): string {
  return `answer/${answerId}`;
}

function deriveAnswerBody(bodyHtml: string | undefined, bodyMarkdown: string | undefined): string {
  const stripped = bodyHtml === undefined ? "" : plainTextFromHtml(bodyHtml);
  if (stripped !== "") {
    return stripped;
  }
  return bodyMarkdown ?? "";
}

export function mapStackOverflowAnswerToItem(
  raw: unknown,
  ctx: StackOverflowAnswerMappingContext,
): StackOverflowAnswerMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }

  const idNum = numberField(row, "id");
  if (idNum === undefined) {
    return null;
  }
  // A deleted answer is not knowledge the team still stands behind; do not index it.
  if (row["isDeleted"] === true) {
    return null;
  }
  const id = String(idNum);

  const rowQuestionId = numberField(row, "questionId");
  const questionId = rowQuestionId === undefined ? ctx.questionId : String(rowQuestionId);

  const body = deriveAnswerBody(stringField(row, "body"), stringField(row, "bodyMarkdown"));
  const canonicalUrl =
    nonEmpty(stringField(row, "webUrl")) ?? nonEmpty(stringField(row, "shareLink"));

  const owner = asRecord(row["owner"]);
  const ownerId = owner === undefined ? null : (numberField(owner, "id") ?? null);
  const ownerName = owner === undefined ? null : (stringField(owner, "name") ?? null);

  const creationDate = parseIsoMs(row["creationDate"]);
  const lastActivityDate = parseIsoMs(row["lastActivityDate"]);
  const lastEditDate = parseIsoMs(row["lastEditDate"]);

  const questionTitle = ctx.questionTitle === null ? "" : ctx.questionTitle.trim();
  const title = questionTitle === "" ? `Answer ${id}` : `Answer: ${questionTitle}`;

  const metadata: Record<string, unknown> = {
    answer_id: id,
    question_id: questionId,
    is_accepted: typeof row["isAccepted"] === "boolean" ? row["isAccepted"] : null,
    score: numberField(row, "score") ?? null,
    comment_count: numberField(row, "commentCount") ?? null,
    owner_id: ownerId,
    owner_name: ownerName,
    creation_date: creationDate,
    last_activity_date: lastActivityDate,
    last_edit_date: lastEditDate,
    canonical_url: canonicalUrl,
  };

  return {
    service: "stackoverflow",
    type: "answer",
    externalId: stackOverflowAnswerExternalId(id),
    title,
    body,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt: lastActivityDate ?? lastEditDate ?? creationDate ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
