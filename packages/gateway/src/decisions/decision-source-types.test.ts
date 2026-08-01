import { expect, test } from "bun:test";

import { DECISION_SOURCE_TYPES, decisionSourceFilter } from "./decision-source-types.ts";

test("admits the discussion and ticket sources the spec names", () => {
  for (const key of [
    "slack:message",
    "notion:page",
    "confluence:page",
    "linear:issue",
    "jira:issue",
  ]) {
    expect(DECISION_SOURCE_TYPES.has(key)).toBe(true);
  }
});

test("excludes email and calendar", () => {
  expect(DECISION_SOURCE_TYPES.has("gmail:email")).toBe(false);
  expect(DECISION_SOURCE_TYPES.has("google:calendar_event")).toBe(false);
});

test("the filter is service-qualified, so a same-named type from another service is excluded", () => {
  const { sql, params } = decisionSourceFilter();
  expect(sql).toContain("(i.service || ':' || i.type)");
  expect(params).toContain("jira:issue");
  expect(params).not.toContain("issue");
  expect(params).not.toContain("wiz:issue");
});

test("the filter emits one placeholder per key", () => {
  const { sql, params } = decisionSourceFilter();
  expect(sql.split("?").length - 1).toBe(params.length);
});
