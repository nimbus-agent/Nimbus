import { describe, expect, test } from "bun:test";

import {
  GITHUB_ISSUE_META_VERSION,
  githubIssueDepthMetadata,
  githubIssueExternalId,
  repoFullFromRepositoryUrl,
} from "./github-issue-meta.ts";

describe("githubIssueDepthMetadata", () => {
  test("an issue with no milestone carries only the version", () => {
    expect(githubIssueDepthMetadata({ milestone: null })).toEqual({ meta_v: 1 });
    expect(githubIssueDepthMetadata({})).toEqual({ meta_v: 1 });
    expect(GITHUB_ISSUE_META_VERSION).toBe(1);
  });

  test("a milestone with a due date gives due_at_ms and milestone", () => {
    expect(
      githubIssueDepthMetadata({ milestone: { title: "v2", due_on: "2026-11-20T08:00:00Z" } }),
    ).toEqual({ meta_v: 1, due_at_ms: Date.parse("2026-11-20T08:00:00Z"), milestone: "v2" });
  });

  test("a milestone without a due date gives milestone only", () => {
    expect(githubIssueDepthMetadata({ milestone: { title: "v3", due_on: null } })).toEqual({
      meta_v: 1,
      milestone: "v3",
    });
  });

  test("a non-string title or an unparseable due date is omitted, never guessed", () => {
    expect(githubIssueDepthMetadata({ milestone: { title: 7, due_on: "soon" } })).toEqual({
      meta_v: 1,
    });
    expect(githubIssueDepthMetadata({ milestone: "v1" })).toEqual({ meta_v: 1 });
  });
});

describe("repoFullFromRepositoryUrl", () => {
  test.each([
    ["https://api.github.com/repos/o/r", "o/r"],
    ["https://ghe.example.com/api/v3/repos/o/r", "o/r"],
    ["https://api.github.com/repos/o.x/r-y_z", "o.x/r-y_z"],
  ])("parses %s", (url, expected) => {
    expect(repoFullFromRepositoryUrl(url)).toBe(expected);
  });

  test.each([
    "https://api.github.com/users/o",
    "https://api.github.com/repos/o",
    "https://api.github.com/repos/o/r/issues",
    "https://api.github.com/repos//r",
    "https://api.github.com/repos/o/",
    "not a url",
    "",
  ])("rejects %p", (url) => {
    expect(repoFullFromRepositoryUrl(url)).toBeUndefined();
  });
});

describe("githubIssueExternalId", () => {
  test("is <repo>#issue-<n>", () => {
    expect(githubIssueExternalId("o/r", 5)).toBe("o/r#issue-5");
  });
});
