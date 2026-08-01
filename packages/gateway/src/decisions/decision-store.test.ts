import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  countByStatus,
  listDecisions,
  markExtracted,
  markVetoed,
  readPassState,
  recordAttempt,
  replaceEvidence,
  selectPendingByPriority,
  selectSnippetUpgrades,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "./decision-store.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function candidate(id: string, priority: number, decidedAt = 1_000): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority,
    decidedAt,
    nowMs: 5_000,
  });
}

test("upsertCandidate is idempotent on the same id", () => {
  candidate("a", 0.4);
  candidate("a", 0.4);
  expect(countByStatus(db).total).toBe(1);
});

test("selectPendingByPriority returns highest priority first", () => {
  candidate("low", 0.1);
  candidate("high", 0.9);
  expect(selectPendingByPriority(db, 10, 0).map((r) => r.id)).toEqual(["high", "low"]);
});

test("selectPendingByPriority breaks ties by decided_at DESC", () => {
  candidate("older", 0.5, 1_000);
  candidate("newer", 0.5, 9_000);
  expect(selectPendingByPriority(db, 10, 0).map((r) => r.id)).toEqual(["newer", "older"]);
});

test("a row attempted more recently than the cooldown is skipped", () => {
  candidate("a", 0.5);
  recordAttempt(db, "a", 10_000);
  expect(selectPendingByPriority(db, 10, 9_000)).toHaveLength(0);
  expect(selectPendingByPriority(db, 10, 11_000)).toHaveLength(1);
});

test("a vetoed row is never re-selected", () => {
  candidate("a", 0.5);
  markVetoed(db, "a", 6_000);
  expect(selectPendingByPriority(db, 10, 0)).toHaveLength(0);
  expect(countByStatus(db).vetoed).toBe(1);
});

test("markExtracted stores alternatives as a round-trippable array", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    {
      statement: "Adopt Postgres",
      rationale: "pool exhaustion",
      alternatives: ["stay on MySQL", "shard"],
      extractionSource: "llm",
    },
    6_000,
  );
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.alternatives).toEqual(["stay on MySQL", "shard"]);
  expect(row?.statement).toBe("Adopt Postgres");
});

test("selectSnippetUpgrades returns only snippet-sourced extracted rows, oldest attempt first", () => {
  candidate("a", 0.5);
  candidate("b", 0.5);
  const fields = {
    statement: "s",
    rationale: null,
    alternatives: [],
    extractionSource: "snippet",
  } as const;
  markExtracted(db, "a", fields, 6_000);
  markExtracted(db, "b", { ...fields, extractionSource: "llm" }, 6_000);
  recordAttempt(db, "a", 1_000);
  expect(selectSnippetUpgrades(db, 10).map((r) => r.id)).toEqual(["a"]);
});

test("replaceEvidence is idempotent and readable back through listDecisions", () => {
  candidate("a", 0.5);
  markExtracted(
    db,
    "a",
    { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" },
    6_000,
  );
  const ev = [
    { kind: "pr", entityId: "e1", itemId: null, label: "#412", url: null, occurredAt: 7_000 },
  ] as const;
  replaceEvidence(db, "a", ev);
  replaceEvidence(db, "a", ev);
  const [row] = listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 });
  expect(row?.evidence).toHaveLength(1);
  expect(row?.evidence[0]?.label).toBe("#412");
});

test("listDecisions filters by since and min confidence, newest first", () => {
  candidate("old", 0.5, 1_000);
  candidate("new", 0.5, 9_000);
  const f = { statement: "s", rationale: null, alternatives: [], extractionSource: "llm" } as const;
  markExtracted(db, "old", f, 6_000);
  markExtracted(db, "new", f, 6_000);
  setConfidence(db, "old", 0.9, false, 6_000);
  setConfidence(db, "new", 0.1, false, 6_000);

  expect(
    listDecisions(db, { sinceMs: 5_000, minConfidence: 0, limit: 10 }).map((r) => r.id),
  ).toEqual(["new"]);
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0.5, limit: 10 }).map((r) => r.id)).toEqual(
    ["old"],
  );
});

test("listDecisions never returns pending or vetoed rows", () => {
  candidate("p", 0.5);
  candidate("v", 0.5);
  markVetoed(db, "v", 6_000);
  expect(listDecisions(db, { sinceMs: 0, minConfidence: 0, limit: 10 })).toHaveLength(0);
});

test("pass state round-trips", () => {
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
  expect(readPassState(db)).toEqual({
    watermarkMs: 42,
    watermarkId: "item-9",
    lastPassAt: 100,
    lastPassNew: 3,
    scannedItems: 7,
  });
});

test("pass state defaults to a zero cursor before any pass", () => {
  expect(readPassState(db).watermarkMs).toBe(0);
  expect(readPassState(db).lastPassAt).toBeNull();
});
