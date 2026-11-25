import { itemPrimaryKey } from "../index/item-key.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { connectorFetch, type FetchOutcome } from "./_lib/fetch-outcome.ts";
import { runSinglePassPaginatedSync, upsertMapped } from "./_lib/paginated-sync.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import {
  mapStackOverflowAnswerToItem,
  stackOverflowAnswerExternalId,
} from "./stackoverflow-answer-mapping.ts";
import { mapStackOverflowQuestionToItem } from "./stackoverflow-question-mapping.ts";
import { asRecord, numberField, stringField } from "./unknown-record.ts";

const SERVICE_ID = "stackoverflow";
const CURSOR_PREFIX = "nimbus-stackoverflow1:";
const BASE = "https://api.stackoverflowteams.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
/**
 * The most answers requests one sync may make.
 *
 * The Teams API serves answers per question only (`/questions/{id}/answers`), so indexing them
 * costs one request per question that has any. The question walk can list up to
 * `MAX_PAGES * PAGE_SIZE` = 2,000 questions, and the limiter allows 60 requests a minute
 * (`sync/rate-limiter.ts`), so the answers pass is bounded: with at most 20 question pages, a
 * sync makes at most 20 + 40 = 60 requests, one minute of budget every ten minutes.
 *
 * A team with more than 40 answered questions is covered over several syncs: the cursor
 * remembers where the last pass stopped (`answersFrom`) and the next one continues from there,
 * wrapping to the newest question at the end.
 */
export const MAX_ANSWER_REQUESTS_PER_SYNC = 40;

type StackOverflowCursorV1 = { pass: number; answersFrom?: number };

function pass1Cursor(answersFrom = 0): string {
  const payload: StackOverflowCursorV1 = answersFrom > 0 ? { pass: 1, answersFrom } : { pass: 1 };
  return encodeNimbusJsonCursor(CURSOR_PREFIX, payload);
}

/** Where the previous sync's answers pass stopped, or 0 for no cursor, an old one or a bad one. */
function answersFromCursor(cursor: string | null): number {
  const payload = decodeNimbusJsonCursorObject(cursor, CURSOR_PREFIX);
  const from = payload === null ? undefined : numberField(payload, "answersFrom");
  return from !== undefined && Number.isInteger(from) && from > 0 ? from : 0;
}

export type StackOverflowSyncableOptions = {
  ensureStackOverflowMcpRunning: () => Promise<void>;
};

interface StackOverflowCreds {
  readonly token: string;
  readonly team: string;
}

async function loadCreds(ctx: SyncContext): Promise<StackOverflowCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  const team = (await ctx.getSecret("team"))?.trim() ?? "";
  if (token === "" || team === "") {
    return null;
  }
  return { token, team };
}

function questionsPath(team: string, page: number): string {
  const params = new URLSearchParams({
    page: String(page),
    pagesize: String(PAGE_SIZE),
    sort: "creation",
    order: "desc",
  });
  return `/v3/teams/${encodeURIComponent(team)}/questions?${params.toString()}`;
}

/**
 * One page of a question's answers, highest score first. A question with more than `PAGE_SIZE`
 * answers has only its top `PAGE_SIZE` indexed: a second page would be a second request against
 * the same per-sync bound, and the best answers are the ones worth finding.
 */
function answersPath(team: string, questionId: string): string {
  const params = new URLSearchParams({
    page: "1",
    pagesize: String(PAGE_SIZE),
    sort: "score",
    order: "desc",
  });
  return `/v3/teams/${encodeURIComponent(team)}/questions/${encodeURIComponent(questionId)}/answers?${params.toString()}`;
}

function stackOverflowGet(ctx: SyncContext, creds: StackOverflowCreds, path: string) {
  return connectorFetch(ctx, SERVICE_ID, `${BASE}${path}`, {
    headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  });
}

function parseStackOverflowPage(
  parsed: unknown,
  page: number,
): { items: unknown[]; hasMore: boolean } {
  const root = asRecord(parsed);
  if (root === undefined) {
    return { items: [], hasMore: false };
  }
  const rawItems = root["items"];
  const items = Array.isArray(rawItems) ? rawItems : [];
  const totalPagesRaw = root["totalPages"];
  const totalPages =
    typeof totalPagesRaw === "number" && Number.isFinite(totalPagesRaw) ? totalPagesRaw : 0;
  return { items, hasMore: items.length > 0 && page < totalPages };
}

/** A question this sync listed that the API says has at least one answer. */
interface AnsweredQuestion {
  readonly id: string;
  readonly title: string | null;
}

function answeredQuestion(raw: unknown): AnsweredQuestion | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const id = numberField(row, "id");
  const answerCount = numberField(row, "answerCount");
  if (id === undefined || answerCount === undefined || answerCount <= 0) {
    return null;
  }
  return { id: String(id), title: stringField(row, "title") ?? null };
}

interface AnswersPassResult {
  readonly upserted: number;
  readonly bytes: number;
  /** Rows removed because the API now reports their answer as deleted. */
  readonly deleted: number;
  /** Index into this sync's answered questions where the next sync's answers pass starts. */
  readonly nextFrom: number;
}

/**
 * Remove the rows of answers the API reports as deleted. The mapper skips a deleted answer, so
 * without this an answer indexed by an earlier sync would stay searchable after its deletion.
 * Returns how many rows it removed.
 */
function removeDeletedAnswers(ctx: SyncContext, items: readonly unknown[]): number {
  let removed = 0;
  for (const raw of items) {
    const row = asRecord(raw);
    if (row?.["isDeleted"] !== true) {
      continue;
    }
    const id = numberField(row, "id");
    if (id === undefined) {
      continue;
    }
    const externalId = stackOverflowAnswerExternalId(String(id));
    if (!ctx.itemExists(itemPrimaryKey(SERVICE_ID, externalId))) {
      continue;
    }
    ctx.deleteItem(SERVICE_ID, externalId);
    removed += 1;
  }
  return removed;
}

/**
 * Index the answers of up to {@link MAX_ANSWER_REQUESTS_PER_SYNC} of the questions this sync
 * listed, starting where the previous sync stopped.
 *
 * This runs after the question walk has finished and written its rows, so nothing here can undo
 * or block question indexing. A 404 means that one question is gone and the pass moves on. Any
 * other failed request (a 5xx, a 429, a body that does not parse, or a request that rejects
 * because the network failed) ends the pass for this sync, and the next sync resumes at the
 * question that failed. An answer the API reports as deleted has its row removed.
 */
async function syncAnswers(
  ctx: SyncContext,
  creds: StackOverflowCreds,
  questions: readonly AnsweredQuestion[],
  from: number,
  now: number,
): Promise<AnswersPassResult> {
  if (questions.length === 0) {
    return { upserted: 0, bytes: 0, deleted: 0, nextFrom: 0 };
  }
  const start = from < questions.length ? from : 0;
  const end = Math.min(start + MAX_ANSWER_REQUESTS_PER_SYNC, questions.length);
  let upserted = 0;
  let bytes = 0;
  let deleted = 0;
  let index = start;
  for (; index < end; index += 1) {
    const question = questions[index];
    if (question === undefined) {
      break;
    }
    let outcome: FetchOutcome;
    try {
      outcome = await stackOverflowGet(ctx, creds, answersPath(creds.team, question.id));
    } catch (err) {
      // A rejected request (network failure, unreadable body) must not fail the run: the
      // question rows are already written, and the cursor has to keep this position.
      ctx.logger.warn(
        { serviceId: SERVICE_ID, questionId: question.id, err },
        "stackoverflow answers request rejected; ending the answers pass",
      );
      break;
    }
    bytes += outcome.bytes;
    if (outcome.kind === "http_error" && outcome.status === 404) {
      continue;
    }
    if (outcome.kind !== "ok") {
      break;
    }
    const { items } = parseStackOverflowPage(outcome.parsed, 1);
    deleted += removeDeletedAnswers(ctx, items);
    upserted += upsertMapped(ctx, items, (raw) =>
      mapStackOverflowAnswerToItem(raw, {
        syncedAt: now,
        questionId: question.id,
        questionTitle: question.title,
      }),
    );
  }
  return { upserted, bytes, deleted, nextFrom: index >= questions.length ? 0 : index };
}

async function syncQuestionsThenAnswers(
  ctx: SyncContext,
  cursor: string | null,
  options: StackOverflowSyncableOptions,
): Promise<SyncResult> {
  const answered: AnsweredQuestion[] = [];
  let credsSeen: StackOverflowCreds | undefined;
  let nowSeen = Date.now();

  const questions = await runSinglePassPaginatedSync(ctx, cursor, {
    ensureRunning: options.ensureStackOverflowMcpRunning,
    loadCreds: () => loadCreds(ctx),
    pass1Cursor: () => pass1Cursor(answersFromCursor(cursor)),
    maxPages: MAX_PAGES,
    startPage: 1,
    fetchPage: (creds, page) => stackOverflowGet(ctx, creds, questionsPath(creds.team, page)),
    parsePage: (parsed, page) => parseStackOverflowPage(parsed, page),
    map: (raw, creds, now) => {
      credsSeen = creds;
      nowSeen = now;
      const question = answeredQuestion(raw);
      if (question !== null) {
        answered.push(question);
      }
      return mapStackOverflowQuestionToItem(raw, { syncedAt: now });
    },
  });

  // No question row was mapped: unconfigured, an empty team, or a failed first page. There is
  // nothing to fetch answers for, and the question result (and its cursor) stands as it is.
  if (credsSeen === undefined) {
    return questions;
  }

  const answers = await syncAnswers(ctx, credsSeen, answered, answersFromCursor(cursor), nowSeen);
  return {
    ...questions,
    cursor: pass1Cursor(answers.nextFrom),
    itemsUpserted: questions.itemsUpserted + answers.upserted,
    itemsDeleted: questions.itemsDeleted + answers.deleted,
    bytesTransferred: (questions.bytesTransferred ?? 0) + answers.bytes,
  };
}

export function createStackOverflowSyncable(options: StackOverflowSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    sync: (ctx, cursor) => syncQuestionsThenAnswers(ctx, cursor, options),
  };
}
