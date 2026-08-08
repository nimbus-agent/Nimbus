import { expect, test } from "bun:test";

import {
  msFromIso,
  normalizeJiraStatusCategory,
  normalizeLinearStateType,
  TICKET_META_VERSION,
} from "./ticket-depth.ts";

test("jira status categories normalize to the shared vocabulary", () => {
  expect(normalizeJiraStatusCategory("new")).toBe("todo");
  expect(normalizeJiraStatusCategory("indeterminate")).toBe("in_progress");
  expect(normalizeJiraStatusCategory("done")).toBe("done");
});

test("jira never yields canceled - it folds Won't Do into done", () => {
  // Jira exposes the distinction only via fields.resolution, which this PR
  // does not fetch. A consumer must read a Jira `done` as "closed, outcome
  // unknown"; if this ever returns "canceled" the contract has drifted.
  //
  // DRIFT TRIPWIRE: if a later PR starts fetching `fields.resolution`, this
  // test is the thing that should fail first. Do not delete it to make the
  // change pass — update it, and update every consumer that was told a Jira
  // `done` means "closed, outcome unknown".
  const all = ["new", "indeterminate", "done"].map(normalizeJiraStatusCategory);
  expect(all).not.toContain("canceled");
});

test("linear state types normalize, keeping canceled distinct from completed", () => {
  expect(normalizeLinearStateType("backlog")).toBe("todo");
  expect(normalizeLinearStateType("unstarted")).toBe("todo");
  expect(normalizeLinearStateType("started")).toBe("in_progress");
  expect(normalizeLinearStateType("completed")).toBe("done");
  expect(normalizeLinearStateType("canceled")).toBe("canceled");
});

test("an unrecognized or absent category is unknown, never todo", () => {
  // "todo" would read as "not started yet" and silently distort every cohort
  // the pre-mortem agent builds. Fail visibly instead.
  expect(normalizeJiraStatusCategory("something-new")).toBe("unknown");
  expect(normalizeLinearStateType("triage")).toBe("unknown");
  expect(normalizeJiraStatusCategory(undefined)).toBe("unknown");
  expect(normalizeLinearStateType("")).toBe("unknown");
});

test("msFromIso returns epoch ms, or undefined for anything unusable", () => {
  expect(msFromIso("2026-01-15T10:30:00.000Z")).toBe(Date.parse("2026-01-15T10:30:00.000Z"));
  expect(msFromIso("2026-01-15")).toBe(Date.parse("2026-01-15"));
  expect(msFromIso(undefined)).toBeUndefined();
  expect(msFromIso("")).toBeUndefined();
  expect(msFromIso("not-a-date")).toBeUndefined();
});

test("the metadata version is 1", () => {
  expect(TICKET_META_VERSION).toBe(1);
});
