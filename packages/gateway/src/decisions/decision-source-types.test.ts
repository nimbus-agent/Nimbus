import { expect, test } from "bun:test";

import { DECISION_SOURCE_TYPES } from "./decision-source-types.ts";

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
