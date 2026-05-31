import { describe, expect, test } from "bun:test";

import {
  mapStackOverflowQuestionToItem,
  tagNames,
} from "../../../src/connectors/stackoverflow-question-mapping.ts";

const CREATED_ISO = "2024-03-01T12:00:00.000Z";
const CREATED_MS = Date.parse(CREATED_ISO);
const ACTIVITY_ISO = "2024-03-02T08:00:00.000Z";
const ACTIVITY_MS = Date.parse(ACTIVITY_ISO);
const EDIT_ISO = "2024-03-01T18:00:00.000Z";
const EDIT_MS = Date.parse(EDIT_ISO);

function makeQuestion(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    title: "How do we handle exponential backoff with jitter for queue retries?",
    body: "<p>We keep seeing <strong>thundering-herd</strong> retries on the payment queue.</p>",
    bodyMarkdown: "We keep seeing thundering-herd retries on the payment queue.",
    tags: [{ name: "reliability" }, { name: "retries" }],
    score: 7,
    viewCount: 120,
    answerCount: 2,
    isAnswered: true,
    owner: { id: 99, name: "Ada Lovelace" },
    webUrl: "https://stackoverflowteams.com/c/acme/questions/4242",
    creationDate: CREATED_ISO,
    lastActivityDate: ACTIVITY_ISO,
    lastEditDate: EDIT_ISO,
    ...over,
  };
}

const NOW = 1_700_009_999_999;

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapStackOverflowQuestionToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapStackOverflowQuestionToItem(null, { syncedAt: NOW })).toBeNull();
    expect(mapStackOverflowQuestionToItem("nope", { syncedAt: NOW })).toBeNull();
    expect(mapStackOverflowQuestionToItem(42, { syncedAt: NOW })).toBeNull();
  });

  test("returns null when id is missing or not a number", () => {
    const noId = makeQuestion();
    delete (noId as Record<string, unknown>)["id"];
    expect(mapStackOverflowQuestionToItem(noId, { syncedAt: NOW })).toBeNull();
    expect(
      mapStackOverflowQuestionToItem(makeQuestion({ id: "4242" }), { syncedAt: NOW }),
    ).toBeNull();
  });

  test("service/type fixed; externalId is the stringified numeric id", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("stackoverflow");
    expect(row.type).toBe("question");
    expect(row.externalId).toBe("4242");
  });

  test("title is the trimmed question title when present", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion({ title: "  spaced title  " }), {
      syncedAt: NOW,
    });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("spaced title");
  });

  test("title falls back to `Question <id>` when title missing/empty", () => {
    const noTitle = makeQuestion();
    delete (noTitle as Record<string, unknown>)["title"];
    const row = mapStackOverflowQuestionToItem(noTitle, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("Question 4242");

    const empty = mapStackOverflowQuestionToItem(makeQuestion({ title: "   " }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.title).toBe("Question 4242");
  });

  test("bodyPreview is the HTML-stripped body", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("We keep seeing thundering-herd retries on the payment queue.");
  });

  test("bodyPreview falls back to bodyMarkdown, then tag summary, then title", () => {
    const noBody = makeQuestion();
    delete (noBody as Record<string, unknown>)["body"];
    const onMarkdown = mapStackOverflowQuestionToItem(noBody, { syncedAt: NOW });
    if (onMarkdown === null) throw new Error("expected mapping to succeed");
    expect(onMarkdown.bodyPreview).toBe(
      "We keep seeing thundering-herd retries on the payment queue.",
    );

    const noText = makeQuestion();
    delete (noText as Record<string, unknown>)["body"];
    delete (noText as Record<string, unknown>)["bodyMarkdown"];
    const onTags = mapStackOverflowQuestionToItem(noText, { syncedAt: NOW });
    if (onTags === null) throw new Error("expected mapping to succeed");
    expect(onTags.bodyPreview).toBe("reliability, retries");

    const bare = makeQuestion();
    delete (bare as Record<string, unknown>)["body"];
    delete (bare as Record<string, unknown>)["bodyMarkdown"];
    delete (bare as Record<string, unknown>)["tags"];
    const onTitle = mapStackOverflowQuestionToItem(bare, { syncedAt: NOW });
    if (onTitle === null) throw new Error("expected mapping to succeed");
    expect(onTitle.bodyPreview).toBe(
      "How do we handle exponential backoff with jitter for queue retries?",
    );
  });

  test("ISO-8601 timestamps → epoch ms (NOT verbatim, NOT epoch seconds)", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["creation_date"]).toBe(CREATED_MS);
    expect(meta(row)["last_activity_date"]).toBe(ACTIVITY_MS);
    expect(meta(row)["last_edit_date"]).toBe(EDIT_MS);
    expect(meta(row)["creation_date"]).toBe(Date.parse(CREATED_ISO));
  });

  test("modifiedAt prefers lastActivityDate, then lastEditDate, then creationDate, then syncedAt", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.modifiedAt).toBe(ACTIVITY_MS);

    const noActivity = makeQuestion();
    delete (noActivity as Record<string, unknown>)["lastActivityDate"];
    const onEdit = mapStackOverflowQuestionToItem(noActivity, { syncedAt: NOW });
    if (onEdit === null) throw new Error("expected mapping to succeed");
    expect(onEdit.modifiedAt).toBe(EDIT_MS);

    const noEdit = makeQuestion();
    delete (noEdit as Record<string, unknown>)["lastActivityDate"];
    delete (noEdit as Record<string, unknown>)["lastEditDate"];
    const onCreated = mapStackOverflowQuestionToItem(noEdit, { syncedAt: NOW });
    if (onCreated === null) throw new Error("expected mapping to succeed");
    expect(onCreated.modifiedAt).toBe(CREATED_MS);

    const noTimes = makeQuestion();
    delete (noTimes as Record<string, unknown>)["lastActivityDate"];
    delete (noTimes as Record<string, unknown>)["lastEditDate"];
    delete (noTimes as Record<string, unknown>)["creationDate"];
    const fallback = mapStackOverflowQuestionToItem(noTimes, { syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
    expect(meta(fallback)["creation_date"]).toBeNull();
    expect(meta(fallback)["last_activity_date"]).toBeNull();
    expect(meta(fallback)["last_edit_date"]).toBeNull();
  });

  test("canonicalUrl/url is the per-question webUrl", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://stackoverflowteams.com/c/acme/questions/4242");
    expect(row.url).toBe("https://stackoverflowteams.com/c/acme/questions/4242");
    expect(meta(row)["canonical_url"]).toBe("https://stackoverflowteams.com/c/acme/questions/4242");
  });

  test("canonicalUrl/url is null when webUrl is null/missing/empty", () => {
    const nullUrl = mapStackOverflowQuestionToItem(makeQuestion({ webUrl: null }), {
      syncedAt: NOW,
    });
    if (nullUrl === null) throw new Error("expected mapping to succeed");
    expect(nullUrl.canonicalUrl).toBeNull();
    expect(nullUrl.url).toBeNull();

    const noUrl = makeQuestion();
    delete (noUrl as Record<string, unknown>)["webUrl"];
    const missing = mapStackOverflowQuestionToItem(noUrl, { syncedAt: NOW });
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(missing.canonicalUrl).toBeNull();

    const empty = mapStackOverflowQuestionToItem(makeQuestion({ webUrl: "" }), { syncedAt: NOW });
    if (empty === null) throw new Error("expected mapping to succeed");
    expect(empty.canonicalUrl).toBeNull();
  });

  test("tags reduced to the tag NAME array (objects and plain strings both tolerated)", () => {
    const objTags = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (objTags === null) throw new Error("expected mapping to succeed");
    expect(meta(objTags)["tags"]).toEqual(["reliability", "retries"]);

    const strTags = mapStackOverflowQuestionToItem(makeQuestion({ tags: ["ops", "infra"] }), {
      syncedAt: NOW,
    });
    if (strTags === null) throw new Error("expected mapping to succeed");
    expect(meta(strTags)["tags"]).toEqual(["ops", "infra"]);
  });

  test("owner_id / owner_name from the nested owner object", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["owner_id"]).toBe(99);
    expect(meta(row)["owner_name"]).toBe("Ada Lovelace");

    const noOwner = makeQuestion();
    delete (noOwner as Record<string, unknown>)["owner"];
    const missing = mapStackOverflowQuestionToItem(noOwner, { syncedAt: NOW });
    if (missing === null) throw new Error("expected mapping to succeed");
    expect(meta(missing)["owner_id"]).toBeNull();
    expect(meta(missing)["owner_name"]).toBeNull();
  });

  test("full metadata flows through", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["question_id"]).toBe("4242");
    expect(m["title"]).toBe("How do we handle exponential backoff with jitter for queue retries?");
    expect(m["score"]).toBe(7);
    expect(m["view_count"]).toBe(120);
    expect(m["answer_count"]).toBe(2);
    expect(m["is_answered"]).toBe(true);
  });

  test("missing numeric/bool fields are null-passthrough in metadata", () => {
    const sparse = makeQuestion();
    delete (sparse as Record<string, unknown>)["score"];
    delete (sparse as Record<string, unknown>)["viewCount"];
    delete (sparse as Record<string, unknown>)["answerCount"];
    delete (sparse as Record<string, unknown>)["isAnswered"];
    delete (sparse as Record<string, unknown>)["tags"];
    const row = mapStackOverflowQuestionToItem(sparse, { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["score"]).toBeNull();
    expect(m["view_count"]).toBeNull();
    expect(m["answer_count"]).toBeNull();
    expect(m["is_answered"]).toBeNull();
    expect(m["tags"]).toEqual([]);
  });

  test("syncedAt propagates", () => {
    const row = mapStackOverflowQuestionToItem(makeQuestion(), { syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("tagNames", () => {
  test("extracts the name field from { name } objects", () => {
    expect(tagNames([{ name: "a" }, { name: "b" }])).toEqual(["a", "b"]);
  });

  test("extracts plain string tags verbatim", () => {
    expect(tagNames(["a", "b"])).toEqual(["a", "b"]);
  });

  test("tolerates non-array, non-object/non-string, and nameless entries", () => {
    expect(tagNames(undefined)).toEqual([]);
    expect(tagNames("nope")).toEqual([]);
    expect(tagNames([null, 7, "", { name: "" }, { other: "x" }, { name: "ok" }, "infra"])).toEqual([
      "ok",
      "infra",
    ]);
  });
});
