import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import {
  markExtracted,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "../decisions/decision-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runDecisions } from "./decisions.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function extracted(id: string, decidedAt: number, confidence: number): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority: 0.5,
    decidedAt,
    nowMs: 1_000,
  });
  markExtracted(
    db,
    id,
    {
      statement: `Decision ${id}`,
      rationale: "because",
      alternatives: ["alt"],
      extractionSource: "llm",
    },
    1_000,
  );
  setConfidence(db, id, confidence, false, 1_000);
}

const ctx = () => ({ db, notify: () => {}, sessionId: "s1" });

// Note: every test passes an explicit `sinceMs: 0`. The agent defaults to a
// 90-day window, and these fixtures use small epoch timestamps (1970), so an
// omitted `sinceMs` filters every row out and the assertions fail confusingly.

test("returns extracted decisions newest first", async () => {
  extracted("a", 1_000, 0.9);
  extracted("b", 9_000, 0.9);
  writePassState(db, {
    watermarkMs: 9_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 2,
    scannedItems: 2,
  });
  const brief = await runDecisions({ sinceMs: 0 }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["b", "a"]);
});

test("filters by minConfidence", async () => {
  extracted("low", 1_000, 0.1);
  extracted("high", 2_000, 0.9);
  writePassState(db, {
    watermarkMs: 2_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 2,
    scannedItems: 2,
  });
  const brief = await runDecisions({ sinceMs: 0, minConfidence: 0.5 }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["high"]);
});

test("reports a gap when no pass has run", async () => {
  // Seed one item so the index is not empty — gap 1 (empty_index) and gap 2
  // (pass never ran) are mutually exclusive (else if), and this test targets
  // gap 2 specifically.
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["seed:1", "jira", "issue", "seed:1", "seed item", 0, 0],
  );
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("has not run"))).toBe(true);
});

test("reports the empty index only when also returning nothing", async () => {
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
});

// The spec's standing honesty note.
test("always reports the 512-character body cap", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  const brief = await runDecisions({ sinceMs: 0 }, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("512"))).toBe(true);
});

test("includes the confidence breakdown only when explain is requested", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  expect(
    (await runDecisions({ sinceMs: 0, explain: true }, ctx())).entries[0]?.explain.length,
  ).toBeGreaterThan(0);
  expect((await runDecisions({ sinceMs: 0 }, ctx())).entries[0]?.explain).toEqual([]);
});
