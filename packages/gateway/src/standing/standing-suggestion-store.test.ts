import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  applyStepRun,
  dismissSuggestion,
  getSuggestion,
  listSuggestions,
  markAccepted,
  markStale,
  markStaleFor,
  newSuggestionId,
  openSuggestion,
  streakOf,
} from "./standing-suggestion-store.ts";

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const key = (
  over: Partial<{ workflowId: string; workflowSha256: string; stepIndex: number }> = {},
) => ({
  workflowId: "wf",
  workflowSha256: H1,
  stepIndex: 1,
  ...over,
});

function fresh(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 90);
  return db;
}

describe("streaks", () => {
  test("counts add one, a reset sets zero, no change leaves it", () => {
    const db = fresh();
    expect(streakOf(db, key())).toBe(0);
    expect(applyStepRun(db, key(), "counts", "r1", 10)).toBe(1);
    expect(applyStepRun(db, key(), "counts", "r2", 11)).toBe(2);
    expect(applyStepRun(db, key(), "no_change", "r3", 12)).toBe(2);
    expect(streakOf(db, key())).toBe(2);
    expect(applyStepRun(db, key(), "resets", "r4", 13)).toBe(0);
    expect(streakOf(db, key())).toBe(0);
    expect(applyStepRun(db, key(), "no_change", "r5", 14)).toBe(0);
  });

  test("a different hash or step is its own key", () => {
    const db = fresh();
    applyStepRun(db, key(), "counts", "r1", 1);
    expect(streakOf(db, key({ workflowSha256: H2 }))).toBe(0);
    expect(streakOf(db, key({ stepIndex: 2 }))).toBe(0);
  });
});

describe("suggestions", () => {
  test("an id is ss_ plus 16 hex", () => {
    expect(newSuggestionId()).toMatch(/^ss_[0-9a-f]{16}$/);
  });

  test("open once per key; a second open for the same key is refused", () => {
    const db = fresh();
    const a = openSuggestion(db, key(), 5, 100);
    expect(a?.status).toBe("open");
    expect(a?.streak).toBe(5);
    expect(openSuggestion(db, key(), 6, 101)).toBeUndefined();
    expect(listSuggestions(db, "open")).toHaveLength(1);
    expect(getSuggestion(db, a?.id ?? "")?.workflowId).toBe("wf");
    expect(getSuggestion(db, "ss_0000000000000000")).toBeUndefined();
  });

  test("a dismissed suggestion for the key blocks a new one; another hash is free", () => {
    const db = fresh();
    const a = openSuggestion(db, key(), 5, 100);
    expect(dismissSuggestion(db, a?.id ?? "", 200)).toBe(true);
    expect(dismissSuggestion(db, a?.id ?? "", 201)).toBe(false);
    expect(getSuggestion(db, a?.id ?? "")?.closedAt).toBe(200);
    expect(openSuggestion(db, key(), 9, 300)).toBeUndefined();
    expect(openSuggestion(db, key({ workflowSha256: H2 }), 5, 300)?.status).toBe("open");
  });

  test("markAccepted records the rule, closes it and zeroes the streak; only an open one", () => {
    const db = fresh();
    applyStepRun(db, key(), "counts", "r1", 1);
    const a = openSuggestion(db, key(), 5, 100);
    expect(markAccepted(db, a?.id ?? "", "sr_0123456789abcdef", 150)).toBe(true);
    const got = getSuggestion(db, a?.id ?? "");
    expect(got?.status).toBe("accepted");
    expect(got?.ruleId).toBe("sr_0123456789abcdef");
    expect(streakOf(db, key())).toBe(0);
    expect(markAccepted(db, a?.id ?? "", "sr_0123456789abcdef", 151)).toBe(false);
    expect(dismissSuggestion(db, a?.id ?? "", 152)).toBe(false);
  });

  test("markStale closes one open suggestion", () => {
    const db = fresh();
    const a = openSuggestion(db, key(), 5, 100);
    expect(markStale(db, a?.id ?? "", 200)).toBe(true);
    expect(markStale(db, a?.id ?? "", 201)).toBe(false);
    expect(getSuggestion(db, a?.id ?? "")?.status).toBe("stale");
  });

  test("markStaleFor closes the other hashes' open suggestions and deletes their streaks", () => {
    const db = fresh();
    applyStepRun(db, key(), "counts", "r", 1);
    applyStepRun(db, key({ workflowSha256: H2 }), "counts", "r", 1);
    applyStepRun(db, key({ workflowId: "other" }), "counts", "r", 1);
    openSuggestion(db, key(), 5, 100);
    openSuggestion(db, key({ workflowSha256: H2 }), 5, 101);
    openSuggestion(db, key({ workflowId: "other" }), 5, 102);
    expect(markStaleFor(db, "wf", H2, 200)).toBe(1);
    expect(streakOf(db, key())).toBe(0);
    expect(streakOf(db, key({ workflowSha256: H2 }))).toBe(1);
    expect(streakOf(db, key({ workflowId: "other" }))).toBe(1);
    const open = listSuggestions(db, "open");
    expect(open.map((s) => `${s.workflowId}/${s.workflowSha256.slice(0, 1)}`)).toEqual([
      "wf/b",
      "other/a",
    ]);
    expect(listSuggestions(db)).toHaveLength(3);
    expect(listSuggestions(db, "stale")).toHaveLength(1);
  });
});
