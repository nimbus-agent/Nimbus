import { describe, expect, test } from "bun:test";

import { mapStackOverflowAnswerToItem } from "../../../src/connectors/stackoverflow-answer-mapping.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const ACTIVITY_ISO = "2024-03-02T08:00:00.000Z";
const ACTIVITY_MS = Date.parse(ACTIVITY_ISO);
const EDIT_ISO = "2024-03-01T18:00:00.000Z";
const EDIT_MS = Date.parse(EDIT_ISO);
const SYNCED_AT = 1_700_000_000_000;

const CTX = {
  syncedAt: SYNCED_AT,
  questionId: "4242",
  questionTitle: "How do we handle exponential backoff with jitter for queue retries?",
};

function makeAnswer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    questionId: 4242,
    body: "<p>Use <strong>full jitter</strong>: sleep a random time up to the capped backoff.</p>",
    score: 5,
    isAccepted: true,
    isDeleted: false,
    commentCount: 2,
    owner: { id: 17, name: "Grace Hopper" },
    webUrl: "https://stackoverflowteams.com/c/acme/questions/4242/9001#9001",
    creationDate: CREATED_ISO,
    lastActivityDate: ACTIVITY_ISO,
    lastEditDate: EDIT_ISO,
    ...over,
  };
}

describe("mapStackOverflowAnswerToItem", () => {
  test("happy path: HTML body stripped to plain text, namespaced id, parent question in metadata", () => {
    const row = mapStackOverflowAnswerToItem(makeAnswer(), CTX);

    expect(row).not.toBeNull();
    expect(row?.service).toBe("stackoverflow");
    expect(row?.type).toBe("answer");
    expect(row?.externalId).toBe("answer/9001");
    expect(row?.body).toBe("Use full jitter : sleep a random time up to the capped backoff.");
    expect(row?.title).toBe(
      "Answer: How do we handle exponential backoff with jitter for queue retries?",
    );
    expect(row?.url).toBe("https://stackoverflowteams.com/c/acme/questions/4242/9001#9001");
    expect(row?.canonicalUrl).toBe(
      "https://stackoverflowteams.com/c/acme/questions/4242/9001#9001",
    );
    expect(row?.modifiedAt).toBe(ACTIVITY_MS);
    expect(row?.syncedAt).toBe(SYNCED_AT);
    expect(row?.metadata).toEqual({
      answer_id: "9001",
      question_id: "4242",
      is_accepted: true,
      score: 5,
      comment_count: 2,
      owner_id: 17,
      owner_name: "Grace Hopper",
      creation_date: CREATED_MS,
      last_activity_date: ACTIVITY_MS,
      last_edit_date: EDIT_MS,
      canonical_url: "https://stackoverflowteams.com/c/acme/questions/4242/9001#9001",
    });
  });

  test("a row with only bodyMarkdown uses it as the body", () => {
    const row = mapStackOverflowAnswerToItem(
      makeAnswer({ body: undefined, bodyMarkdown: "Use **full jitter**." }),
      CTX,
    );
    expect(row?.body).toBe("Use **full jitter**.");
  });

  test("the stripped HTML body is preferred over bodyMarkdown", () => {
    const row = mapStackOverflowAnswerToItem(
      makeAnswer({ body: "<p>from html</p>", bodyMarkdown: "from markdown" }),
      CTX,
    );
    expect(row?.body).toBe("from html");
  });

  test("an HTML body that strips to nothing falls back to bodyMarkdown", () => {
    const row = mapStackOverflowAnswerToItem(
      makeAnswer({ body: "<p> </p>", bodyMarkdown: "from markdown" }),
      CTX,
    );
    expect(row?.body).toBe("from markdown");
  });

  test.each([
    ["missing id", { id: undefined }],
    ["empty-string id", { id: "" }],
    ["non-numeric id", { id: "abc" }],
    ["null id", { id: null }],
  ])("%s → skipped", (_label, over) => {
    expect(mapStackOverflowAnswerToItem(makeAnswer(over), CTX)).toBeNull();
  });

  test("a non-object row → skipped", () => {
    expect(mapStackOverflowAnswerToItem("nope", CTX)).toBeNull();
    expect(mapStackOverflowAnswerToItem(null, CTX)).toBeNull();
  });

  test("a deleted answer → skipped", () => {
    expect(mapStackOverflowAnswerToItem(makeAnswer({ isDeleted: true }), CTX)).toBeNull();
  });

  test("the question id comes from the request context when the row omits it", () => {
    const row = mapStackOverflowAnswerToItem(makeAnswer({ questionId: undefined }), CTX);
    expect(row?.metadata["question_id"]).toBe("4242");
  });

  test("the row's own questionId wins over the request context", () => {
    const row = mapStackOverflowAnswerToItem(makeAnswer({ questionId: 77 }), CTX);
    expect(row?.metadata["question_id"]).toBe("77");
  });

  test("title falls back to the answer id when the question title is unknown or blank", () => {
    const noTitle = mapStackOverflowAnswerToItem(makeAnswer(), {
      syncedAt: SYNCED_AT,
      questionId: "4242",
      questionTitle: null,
    });
    expect(noTitle?.title).toBe("Answer 9001");
    const blank = mapStackOverflowAnswerToItem(makeAnswer(), {
      syncedAt: SYNCED_AT,
      questionId: "4242",
      questionTitle: "   ",
    });
    expect(blank?.title).toBe("Answer 9001");
  });

  test("url falls back to shareLink, then null", () => {
    const share = mapStackOverflowAnswerToItem(
      makeAnswer({ webUrl: null, shareLink: "https://stackoverflowteams.com/c/acme/a/9001" }),
      CTX,
    );
    expect(share?.url).toBe("https://stackoverflowteams.com/c/acme/a/9001");
    const none = mapStackOverflowAnswerToItem(makeAnswer({ webUrl: "", shareLink: null }), CTX);
    expect(none?.url).toBeNull();
    expect(none?.canonicalUrl).toBeNull();
    expect(none?.metadata["canonical_url"]).toBeNull();
  });

  test("modifiedAt falls back: lastActivityDate → lastEditDate → creationDate → syncedAt", () => {
    const edit = mapStackOverflowAnswerToItem(makeAnswer({ lastActivityDate: null }), CTX);
    expect(edit?.modifiedAt).toBe(EDIT_MS);
    const created = mapStackOverflowAnswerToItem(
      makeAnswer({ lastActivityDate: null, lastEditDate: null }),
      CTX,
    );
    expect(created?.modifiedAt).toBe(CREATED_MS);
    const synced = mapStackOverflowAnswerToItem(
      makeAnswer({ lastActivityDate: null, lastEditDate: "not a date", creationDate: undefined }),
      CTX,
    );
    expect(synced?.modifiedAt).toBe(SYNCED_AT);
  });

  test("missing optional fields map to null, and a missing owner does not throw", () => {
    const row = mapStackOverflowAnswerToItem(
      makeAnswer({
        score: undefined,
        isAccepted: undefined,
        commentCount: undefined,
        owner: undefined,
      }),
      CTX,
    );
    expect(row?.metadata["score"]).toBeNull();
    expect(row?.metadata["is_accepted"]).toBeNull();
    expect(row?.metadata["comment_count"]).toBeNull();
    expect(row?.metadata["owner_id"]).toBeNull();
    expect(row?.metadata["owner_name"]).toBeNull();
  });

  test("an answer with no text at all is still indexed, with an empty body", () => {
    const row = mapStackOverflowAnswerToItem(
      makeAnswer({ body: undefined, bodyMarkdown: undefined }),
      CTX,
    );
    expect(row?.body).toBe("");
    expect(row?.externalId).toBe("answer/9001");
  });
});
