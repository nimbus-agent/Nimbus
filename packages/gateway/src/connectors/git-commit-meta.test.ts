import { expect, test } from "bun:test";

import { buildGitCommitMetadata, GIT_COMMIT_META_VERSION } from "./git-commit-meta.ts";

test("writes author_email verbatim and stamps meta_v", () => {
  expect(buildGitCommitMetadata({ sha: "a" }, { authorEmail: "Ada@Example.com" })).toEqual({
    sha: "a",
    author_email: "Ada@Example.com",
    meta_v: GIT_COMMIT_META_VERSION,
  });
});

test("an empty or missing email is omitted, never written as empty", () => {
  expect(buildGitCommitMetadata({}, { authorEmail: "" })).toEqual({ meta_v: 1 });
  expect(buildGitCommitMetadata({}, {})).toEqual({ meta_v: 1 });
});

test("a raw author_email cannot survive the builder", () => {
  expect(buildGitCommitMetadata({ author_email: "x@y" }, {})).toEqual({ meta_v: 1 });
});
