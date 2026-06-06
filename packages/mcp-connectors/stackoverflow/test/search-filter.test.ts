import { describe, expect, test } from "bun:test";

import { filterStackOverflowQuestions } from "../src/search-filter.ts";

function question(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4242,
    title: "How do we handle exponential backoff with jitter for queue retries?",
    body: "<p>We keep seeing thundering-herd retries on the payment queue.</p>",
    bodyMarkdown: "We keep seeing thundering-herd retries on the payment queue.",
    tags: [{ name: "reliability" }, { name: "retries" }],
    score: 7,
    viewCount: 120,
    answerCount: 2,
    isAnswered: true,
    owner: { id: 99, name: "Ada Lovelace" },
    webUrl: "https://stackoverflowteams.com/c/acme/questions/4242",
    creationDate: "2024-03-01T12:00:00.000Z",
    lastActivityDate: "2024-03-02T08:00:00.000Z",
    ...over,
  };
}

describe("filterStackOverflowQuestions", () => {
  test("matches against question title (case-insensitive)", () => {
    expect(
      filterStackOverflowQuestions([question()], { query: "exponential backoff" }),
    ).toHaveLength(1);
    expect(filterStackOverflowQuestions([question()], { query: "EXPONENTIAL" })).toHaveLength(1);
  });

  test("matches against body, bodyMarkdown, tags, and owner name", () => {
    expect(filterStackOverflowQuestions([question()], { query: "thundering-herd" })).toHaveLength(
      1,
    );
    expect(filterStackOverflowQuestions([question()], { query: "payment queue" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([question()], { query: "reliability" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([question()], { query: "retries" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([question()], { query: "Ada Lovelace" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterStackOverflowQuestions([question()], { query: "nonsense" })).toHaveLength(0);
  });

  test("does not match against the webUrl (not in the haystack)", () => {
    expect(filterStackOverflowQuestions([question()], { query: "/questions/4242" })).toHaveLength(
      0,
    );
  });

  test("skips non-object entries", () => {
    expect(
      filterStackOverflowQuestions([null, 42, "x", question()], { query: "reliability" }),
    ).toHaveLength(1);
  });

  test("tolerates plain-string tags as well as { name } objects", () => {
    const stringTags = question({ tags: ["reliability", "ops"] });
    expect(filterStackOverflowQuestions([stringTags], { query: "reliability" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([stringTags], { query: "ops" })).toHaveLength(1);
  });

  test("tolerates missing string fields and non-object/non-string tags", () => {
    const sparse = question();
    delete sparse["body"];
    delete sparse["bodyMarkdown"];
    sparse["tags"] = [null, 7, { name: "ops" }, "infra"];
    delete sparse["owner"];
    expect(filterStackOverflowQuestions([sparse], { query: "exponential backoff" })).toHaveLength(
      1,
    );
    expect(filterStackOverflowQuestions([sparse], { query: "ops" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([sparse], { query: "infra" })).toHaveLength(1);
    expect(filterStackOverflowQuestions([sparse], { query: "thundering-herd" })).toHaveLength(0);
    expect(filterStackOverflowQuestions([sparse], { query: "Ada Lovelace" })).toHaveLength(0);
  });

  test("tolerates a missing tags array", () => {
    const noTags = question();
    delete noTags["tags"];
    expect(filterStackOverflowQuestions([noTags], { query: "exponential backoff" })).toHaveLength(
      1,
    );
    expect(filterStackOverflowQuestions([noTags], { query: "reliability" })).toHaveLength(0);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => question({ id: i }));
    expect(
      filterStackOverflowQuestions(many, { query: "exponential backoff", limit: 3 }),
    ).toHaveLength(3);
  });
});
