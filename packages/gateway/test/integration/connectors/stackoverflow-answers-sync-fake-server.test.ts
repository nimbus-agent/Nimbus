import { afterEach, describe, expect, test } from "bun:test";
import {
  createStackOverflowSyncable,
  MAX_ANSWER_REQUESTS_PER_SYNC,
} from "../../../src/connectors/stackoverflow-sync.ts";
import {
  answer,
  answersRequestIds,
  answersRequests,
  type FakeAnswers,
  type FakeStackOverflowConfig,
  type Harness,
  QUESTIONS_PATH,
  question,
  startHarness,
  TEAM,
  withRewrittenFetch,
} from "../../helpers/stackoverflow-fake-server.ts";

describe("stackoverflow-sync answers against Bun.serve fake API", () => {
  let h: Harness | undefined;
  let restoreFetch: (() => void) | undefined;
  afterEach(() => {
    restoreFetch?.();
    restoreFetch = undefined;
    h?.cleanup();
    h = undefined;
  });

  async function configured(config: FakeStackOverflowConfig): Promise<Harness> {
    const harness = startHarness(config);
    restoreFetch = withRewrittenFetch(harness.fake.baseUrl);
    await harness.vault.set("stackoverflow.token", "so_test_token");
    await harness.vault.set("stackoverflow.team", TEAM);
    return harness;
  }

  function syncable() {
    return createStackOverflowSyncable({ ensureStackOverflowMcpRunning: async () => {} });
  }

  test("happy path: answers are upserted as stackoverflow:answer items after a sync", async () => {
    h = await configured({
      pages: [[question(1, { answerCount: 2 }), question(2, { answerCount: 0 })]],
      answers: { "1": [answer(11, 1, { isAccepted: true }), answer(12, 1)] },
    });

    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(4);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-stackoverflow1:")).toBe(true);

    // Only the question that has answers is asked for them.
    const reqs = answersRequests(h.fake);
    expect(reqs.map((r) => r.path)).toEqual([`${QUESTIONS_PATH}/1/answers`]);
    expect(reqs[0]?.query).toContain("pagesize=100");
    expect(reqs[0]?.query).toContain("sort=score");
    expect(reqs[0]?.authorization).toBe("Bearer so_test_token");

    const rows = h.db
      .query<
        {
          id: string;
          external_id: string;
          title: string;
          body: string;
          canonical_url: string | null;
          metadata: string;
        },
        []
      >(
        "SELECT id, external_id, title, body, canonical_url, metadata FROM item WHERE service = 'stackoverflow' AND type = 'answer' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.id)).toEqual(["stackoverflow:answer/11", "stackoverflow:answer/12"]);
    expect(rows.map((r) => r.external_id)).toEqual(["answer/11", "answer/12"]);
    expect(rows[0]?.title).toBe("Answer: Question 1 — exponential backoff with jitter");
    expect(rows[0]?.body).toBe("Use full jitter for answer 11.");
    expect(rows[0]?.canonical_url).toBe("https://stackoverflowteams.com/c/acme/questions/1/11");
    const metadata = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(metadata["question_id"]).toBe("1");
    expect(metadata["answer_id"]).toBe("11");
    expect(metadata["is_accepted"]).toBe(true);
  });

  test("a question and an answer with the same numeric id both survive as separate items", async () => {
    h = await configured({
      pages: [[question(5, { answerCount: 1 })]],
      answers: { "5": [answer(5, 5)] },
    });

    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const rows = h.db
      .query<{ id: string; type: string }, []>(
        "SELECT id, type FROM item WHERE service = 'stackoverflow' ORDER BY id",
      )
      .all();
    expect(rows).toEqual([
      { id: "stackoverflow:5", type: "question" },
      { id: "stackoverflow:answer/5", type: "answer" },
    ]);
  });

  test("the answers request count never exceeds the per-sync bound, and the next sync continues", async () => {
    const total = MAX_ANSWER_REQUESTS_PER_SYNC + 5;
    const questions = Array.from({ length: total }, (_, i) => question(i + 1));
    const answers: Record<string, FakeAnswers> = {};
    for (let i = 1; i <= total; i += 1) {
      answers[String(i)] = [answer(1000 + i, i)];
    }
    h = await configured({ pages: [questions], answers });

    const first = await syncable().sync(h.ctx, null);

    expect(answersRequests(h.fake)).toHaveLength(MAX_ANSWER_REQUESTS_PER_SYNC);
    expect(first.itemsUpserted).toBe(total + MAX_ANSWER_REQUESTS_PER_SYNC);
    expect(answersRequestIds(h.fake)).toEqual(
      Array.from({ length: MAX_ANSWER_REQUESTS_PER_SYNC }, (_, i) => String(i + 1)),
    );

    // The second sync starts where the first stopped and reaches the remaining questions.
    h.fake.requests.length = 0;
    const second = await syncable().sync(h.ctx, first.cursor);

    expect(answersRequestIds(h.fake)).toEqual(
      Array.from({ length: 5 }, (_, i) => String(MAX_ANSWER_REQUESTS_PER_SYNC + i + 1)),
    );
    expect(second.itemsUpserted).toBe(total + 5);
    const indexed = h.db
      .query<{ n: number }, []>(
        "SELECT COUNT(*) AS n FROM item WHERE service = 'stackoverflow' AND type = 'answer'",
      )
      .get();
    expect(indexed?.n).toBe(total);

    // After a full round the third sync starts again at the newest question.
    h.fake.requests.length = 0;
    await syncable().sync(h.ctx, second.cursor);
    expect(answersRequestIds(h.fake)[0]).toBe("1");
    expect(answersRequests(h.fake)).toHaveLength(MAX_ANSWER_REQUESTS_PER_SYNC);
  });

  test.each([
    ["a 5xx", { status: 503 } as FakeAnswers],
    ["a 429", { status: 429 } as FakeAnswers],
    ["a body that does not parse", "badJson" as FakeAnswers],
  ])("a failing answers request (%s) leaves question indexing intact", async (_label, failure) => {
    h = await configured({
      pages: [[question(1), question(2), question(3)]],
      answers: { "1": [answer(11, 1)], "2": failure, "3": [answer(31, 3)] },
    });

    const first = await syncable().sync(h.ctx, null);

    // All three questions are indexed, and so is the answer fetched before the failure.
    expect(first.itemsUpserted).toBe(4);
    const types = h.db
      .query<{ type: string; n: number }, []>(
        "SELECT type, COUNT(*) AS n FROM item WHERE service = 'stackoverflow' GROUP BY type ORDER BY type",
      )
      .all();
    expect(types).toEqual([
      { type: "answer", n: 1 },
      { type: "question", n: 3 },
    ]);
    // The pass stops at the failure instead of spending requests behind it.
    expect(answersRequestIds(h.fake)).toEqual(["1", "2"]);

    // The next sync resumes at the question that failed.
    h.fake.requests.length = 0;
    await syncable().sync(h.ctx, first.cursor);
    expect(answersRequestIds(h.fake)[0]).toBe("2");
  });

  test("a 404 for one question's answers skips that question and carries on", async () => {
    h = await configured({
      pages: [[question(1), question(2), question(3)]],
      answers: { "1": [answer(11, 1)], "3": [answer(31, 3)] },
    });

    const result = await syncable().sync(h.ctx, null);

    expect(answersRequestIds(h.fake)).toEqual(["1", "2", "3"]);
    expect(result.itemsUpserted).toBe(5);
  });

  test("deleted answers and rows without a numeric id are not indexed", async () => {
    h = await configured({
      pages: [[question(1, { answerCount: 3 })]],
      answers: {
        "1": [answer(11, 1), answer(12, 1, { isDeleted: true }), answer(13, 1, { id: "x" })],
      },
    });

    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    const ids = h.db
      .query<{ id: string }, []>(
        "SELECT id FROM item WHERE service = 'stackoverflow' AND type = 'answer'",
      )
      .all();
    expect(ids).toEqual([{ id: "stackoverflow:answer/11" }]);
  });

  test("an answer that is deleted after it was indexed has its row removed", async () => {
    const answers: Record<string, FakeAnswers> = { "1": [answer(11, 1), answer(12, 1)] };
    h = await configured({ pages: [[question(1, { answerCount: 2 })]], answers });

    const first = await syncable().sync(h.ctx, null);
    expect(first.itemsUpserted).toBe(3);
    expect(first.itemsDeleted).toBe(0);

    answers["1"] = [answer(11, 1), answer(12, 1, { isDeleted: true })];
    const second = await syncable().sync(h.ctx, first.cursor);

    expect(second.itemsDeleted).toBe(1);
    const ids = h.db
      .query<{ id: string }, []>(
        "SELECT id FROM item WHERE service = 'stackoverflow' AND type = 'answer'",
      )
      .all();
    expect(ids).toEqual([{ id: "stackoverflow:answer/11" }]);

    // A third sync finds no row left to remove.
    const third = await syncable().sync(h.ctx, second.cursor);
    expect(third.itemsDeleted).toBe(0);
  });

  test("an answers request that rejects ends only the answers pass", async () => {
    h = await configured({
      pages: [[question(1), question(2), question(3)]],
      answers: { "1": [answer(11, 1)], "2": [answer(21, 2)], "3": [answer(31, 3)] },
    });
    const rewritten = globalThis.fetch;
    const restoreRewritten = restoreFetch;
    let failing = true;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (failing && url.includes("/questions/2/answers?")) {
        return Promise.reject(new TypeError("fetch failed"));
      }
      return rewritten(input, init);
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = rewritten;
      restoreRewritten?.();
    };

    const first = await syncable().sync(h.ctx, null);

    // The run resolves: three questions and the answer fetched before the rejection.
    expect(first.itemsUpserted).toBe(4);
    expect(answersRequestIds(h.fake)).toEqual(["1"]);

    // The next sync resumes at the question whose request was rejected.
    failing = false;
    h.fake.requests.length = 0;
    const second = await syncable().sync(h.ctx, first.cursor);
    expect(answersRequestIds(h.fake)).toEqual(["2", "3"]);
    expect(second.itemsUpserted).toBe(5);
  });

  test("new questions posted between syncs do not shift where the answers pass continues", async () => {
    const total = MAX_ANSWER_REQUESTS_PER_SYNC + 5;
    const page = Array.from({ length: total }, (_, i) => question(i + 1));
    const answers: Record<string, FakeAnswers> = { "9001": [answer(90011, 9001)] };
    for (let i = 1; i <= total; i += 1) {
      answers[String(i)] = [answer(1000 + i, i)];
    }
    answers["9002"] = [answer(90021, 9002)];
    h = await configured({ pages: [page], answers });

    const first = await syncable().sync(h.ctx, null);
    expect(answersRequestIds(h.fake)).toHaveLength(MAX_ANSWER_REQUESTS_PER_SYNC);

    // Two questions are posted before the next sync. The list is newest first, so every older
    // question moves down two places.
    page.unshift(question(9002), question(9001));
    h.fake.requests.length = 0;
    const second = await syncable().sync(h.ctx, first.cursor);

    // The pass continues with the questions it had not reached: none twice, none skipped.
    expect(answersRequestIds(h.fake)).toEqual(
      Array.from({ length: 5 }, (_, i) => String(MAX_ANSWER_REQUESTS_PER_SYNC + i + 1)),
    );

    // Having reached the oldest question, the next pass starts again at the newest.
    h.fake.requests.length = 0;
    await syncable().sync(h.ctx, second.cursor);
    expect(answersRequestIds(h.fake).slice(0, 3)).toEqual(["9002", "9001", "1"]);
  });

  test("a cursor from before the question-id rotation point starts from the newest question", async () => {
    h = await configured({
      pages: [[question(1), question(2), question(3)]],
      answers: { "1": [answer(11, 1)], "2": [answer(21, 2)], "3": [answer(31, 3)] },
    });
    // The first version of the answers pass stored a list position: { pass: 1, answersFrom: 2 }.
    const oldCursor = `nimbus-stackoverflow1:${Buffer.from(
      JSON.stringify({ pass: 1, answersFrom: 2 }),
      "utf8",
    ).toString("base64url")}`;

    await syncable().sync(h.ctx, oldCursor);

    expect(answersRequestIds(h.fake)).toEqual(["1", "2", "3"]);
  });

  test("a cursor whose question is no longer listed starts from the newest question", async () => {
    const total = MAX_ANSWER_REQUESTS_PER_SYNC + 5;
    const page = Array.from({ length: total }, (_, i) => question(i + 1));
    const answers: Record<string, FakeAnswers> = {};
    for (let i = 1; i <= total; i += 1) {
      answers[String(i)] = [answer(1000 + i, i)];
    }
    h = await configured({ pages: [page], answers });
    const first = await syncable().sync(h.ctx, null);

    // The last question the first pass handled is deleted before the next sync.
    page.splice(MAX_ANSWER_REQUESTS_PER_SYNC - 1, 1);
    h.fake.requests.length = 0;
    await syncable().sync(h.ctx, first.cursor);

    expect(answersRequestIds(h.fake)[0]).toBe("1");
    expect(answersRequests(h.fake)).toHaveLength(MAX_ANSWER_REQUESTS_PER_SYNC);
  });

  test("a question listed on two pages gets one answers request", async () => {
    // A question posted during the walk pushes the last question of page 1 onto page 2.
    h = await configured({
      pages: [
        [question(1), question(2)],
        [question(2), question(3)],
      ],
      answers: { "1": [answer(11, 1)], "2": [answer(21, 2)], "3": [answer(31, 3)] },
    });

    await syncable().sync(h.ctx, null);

    expect(answersRequestIds(h.fake)).toEqual(["1", "2", "3"]);
  });

  test("no answers request is made when no listed question has answers", async () => {
    h = await configured({
      pages: [[question(1, { answerCount: 0 }), question(2, { answerCount: undefined })]],
    });

    const result = await syncable().sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(answersRequests(h.fake)).toHaveLength(0);
  });
});
