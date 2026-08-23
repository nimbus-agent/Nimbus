import { describe, expect, test } from "bun:test";

import { parseWriteScope, scopeAllows } from "./write-scope.ts";

const KINDS = ["repo", "dataset"] as const;

describe("parseWriteScope", () => {
  test("an unset scope parses to empty", () => {
    expect(parseWriteScope(undefined, KINDS)).toEqual([]);
    expect(parseWriteScope("", KINDS)).toEqual([]);
  });

  test("parses comma-separated kind:value terms and trims whitespace", () => {
    expect(parseWriteScope(" repo:acme/api , repo:acme/web ", KINDS)).toEqual([
      { kind: "repo", value: "acme/api" },
      { kind: "repo", value: "acme/web" },
    ]);
  });

  test("keeps colons inside the value — a value may itself be qualified", () => {
    expect(parseWriteScope("dataset:proj:analytics", KINDS)).toEqual([
      { kind: "dataset", value: "proj:analytics" },
    ]);
  });

  test("an UNKNOWN kind throws — a silently unmatched rule would fail open", () => {
    expect(() => parseWriteScope("page:abc", KINDS)).toThrow(/unknown scope kind "page"/);
  });

  test("a term with no kind separator throws rather than being guessed at", () => {
    expect(() => parseWriteScope("acme/api", KINDS)).toThrow(/expected "kind:value"/);
  });

  test("an empty value throws", () => {
    expect(() => parseWriteScope("repo:", KINDS)).toThrow(/empty value/);
  });
});

describe("scopeAllows", () => {
  const scope = parseWriteScope("repo:acme/api", KINDS);

  test("an EMPTY scope denies everything — unset must not mean unrestricted", () => {
    expect(scopeAllows([], "repo", "acme/api")).toBe(false);
  });

  test("matches an exact kind+value pair", () => {
    expect(scopeAllows(scope, "repo", "acme/api")).toBe(true);
  });

  test("does not match a different value or a different kind", () => {
    expect(scopeAllows(scope, "repo", "acme/other")).toBe(false);
    expect(scopeAllows(scope, "dataset", "acme/api")).toBe(false);
  });

  test("matching is exact, never a prefix — acme/api must not authorise acme/api-secrets", () => {
    expect(scopeAllows(scope, "repo", "acme/api-secrets")).toBe(false);
  });
});
