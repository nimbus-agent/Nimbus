import { describe, expect, test } from "bun:test";

import { isValidWildcardHost, wildcardHostMatches } from "./net-wildcard-hosts.ts";

describe("isValidWildcardHost", () => {
  test.each([
    "*.sharepoint.com",
    "*-run.googleapis.com",
    "p*-caldav.icloud.com",
    "ecs.*.amazonaws.com",
    "ecs.*.amazonaws.com.cn",
  ])("accepts %s", (pattern) => {
    expect(isValidWildcardHost(pattern)).toBe(true);
  });

  test.each([
    ["too few labels after the wildcard", "*.com"],
    ["a bare star", "*"],
    ["two wildcard labels", "*.*.example.com"],
    ["two stars in one label", "a*b*.example.com"],
    ["a port", "*.example.com:443"],
    ["upper case", "*.EXAMPLE.com"],
    ["no wildcard", "api.github.com"],
    ["an empty label", "*..example.com"],
    ["an empty pattern", ""],
    ["a trailing dot", "*.example.com."],
    ["a literal label starting with a hyphen", "*.-example.com"],
    ["an underscore", "*.exa_mple.com"],
  ])("refuses %s: %s", (_why, pattern) => {
    expect(isValidWildcardHost(pattern)).toBe(false);
  });

  test("refuses a label over 63 characters and a name over 253", () => {
    expect(isValidWildcardHost(`*.${"a".repeat(64)}.com`)).toBe(false);
    expect(isValidWildcardHost(`*.${"a.".repeat(130)}com`)).toBe(false);
  });
});

describe("wildcardHostMatches", () => {
  test("a star stands for one label", () => {
    expect(wildcardHostMatches("*.sharepoint.com", "contoso-my.sharepoint.com")).toBe(true);
  });

  test.each([
    "a.b.sharepoint.com",
    "sharepoint.com",
    "evilsharepoint.com",
    "contoso-my.sharepoint.com.evil.example",
    "con_toso.sharepoint.com",
    "Contoso.sharepoint.com",
  ])("*.sharepoint.com does not match %s", (name) => {
    expect(wildcardHostMatches("*.sharepoint.com", name)).toBe(false);
  });

  test("a wildcard in the middle", () => {
    expect(wildcardHostMatches("ecs.*.amazonaws.com", "ecs.us-east-1.amazonaws.com")).toBe(true);
    expect(wildcardHostMatches("ecs.*.amazonaws.com", "ecs.a.b.amazonaws.com")).toBe(false);
    expect(wildcardHostMatches("ecs.*.amazonaws.com", "ecs.us-east-1.amazonaws.com.cn")).toBe(
      false,
    );
    expect(wildcardHostMatches("ecs.*.amazonaws.com.cn", "ecs.cn-north-1.amazonaws.com.cn")).toBe(
      true,
    );
  });

  test("the star needs at least one character", () => {
    expect(wildcardHostMatches("*-run.googleapis.com", "us-central1-run.googleapis.com")).toBe(
      true,
    );
    expect(wildcardHostMatches("*-run.googleapis.com", "-run.googleapis.com")).toBe(false);
    expect(wildcardHostMatches("p*-caldav.icloud.com", "p-caldav.icloud.com")).toBe(false);
    expect(wildcardHostMatches("p*-caldav.icloud.com", "p42-caldav.icloud.com")).toBe(true);
  });

  test("an invalid pattern matches nothing, not even itself", () => {
    expect(wildcardHostMatches("*.com", "example.com")).toBe(false);
    expect(wildcardHostMatches("*", "example")).toBe(false);
    expect(wildcardHostMatches("api.github.com", "api.github.com")).toBe(false);
  });
});
