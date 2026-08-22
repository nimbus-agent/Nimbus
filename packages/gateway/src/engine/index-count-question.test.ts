import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { countQuestionType, indexCountFor, indexCountLine } from "./index-count-question.ts";

/**
 * F23 — `nimbus ask "how many PRs are in the index?"` answered "3", then "2.2 PRs: Wingetbot PR
 * Triage (queued) and Wingetbot PR Triage (pending)", then nothing. Ground truth: 173.
 *
 * `2.2` is the tell — no arithmetic over any set yields it, so nothing was being counted. And the
 * two items named as PRs were `github_actions` workflow runs, F12b's swamping putting non-PR rows
 * into the context of a question explicitly about PRs.
 */

const openDbs: Database[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function dbWith(rows: ReadonlyArray<{ id: string; type: string }>): Database {
  const db = new Database(":memory:");
  openDbs.push(db);
  LocalIndex.ensureSchema(db);
  for (const r of rows) {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
       VALUES (?, 'github', ?, ?, 't', '', 1, 1)`,
      [r.id, r.type, r.id],
    );
  }
  return db;
}

describe("countQuestionType", () => {
  test.each([
    ["how many PRs are in the index?", "pr"],
    ["how many pull requests do I have", "pr"],
    ["number of issues indexed", "issue"],
    ["count of deployments", "deployment"],
  ])("%s -> %s", (q, expected) => {
    expect(countQuestionType(q)).toBe(expected);
  });

  test("a count question naming no indexed type counts all items", () => {
    expect(countQuestionType("how many things are indexed?")).toBeNull();
  });

  test.each([
    ["list my PRs", "an enumeration, which is F14's territory"],
    ["what changed in billing?", "an ordinary question"],
    ["which PRs did not touch src?", "a negation, which is F20/F21's"],
  ])("%s is not a count question (%s)", (q) => {
    expect(countQuestionType(q)).toBeUndefined();
  });
});

describe("indexCountFor", () => {
  test("counts only the type asked about", () => {
    // The exact failure: workflow runs outnumbered PRs 11,361 to 213, and the model counted the
    // runs it had been handed.
    const db = dbWith([
      { id: "a", type: "pr" },
      { id: "b", type: "pr" },
      { id: "c", type: "ci_run" },
      { id: "d", type: "ci_run" },
    ]);
    expect(indexCountFor(db, "how many PRs?")).toEqual({ itemType: "pr", total: 2 });
  });

  test("returns undefined for a non-count question, so nothing is appended", () => {
    expect(indexCountFor(dbWith([]), "what changed in billing?")).toBeUndefined();
  });

  test("zero is a real answer and is reported", () => {
    expect(indexCountFor(dbWith([{ id: "c", type: "ci_run" }]), "how many PRs?")).toEqual({
      itemType: "pr",
      total: 0,
    });
  });
});

describe("indexCountLine", () => {
  test("states the number and that it is not the model's", () => {
    const line = indexCountLine({ itemType: "pr", total: 173 });
    expect(line).toContain("173");
    expect(line).toContain("not the model's estimate");
  });

  test("singular reads correctly", () => {
    expect(indexCountLine({ itemType: "pr", total: 1 })).toContain("indexed `pr` item.");
    expect(indexCountLine({ itemType: "pr", total: 2 })).toContain("indexed `pr` items.");
  });
});
