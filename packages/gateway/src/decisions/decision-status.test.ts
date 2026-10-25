import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { BUILTIN_SOURCE_MAPPING } from "../sources/source-mapping.ts";
import { readDecisionStatus } from "./decision-status.ts";
import { markExtracted, setConfidence, upsertCandidate } from "./decision-store.ts";
import { DECISIONS_DEFAULT_WINDOW_MS } from "./decision-types.ts";

const DAY = 86_400_000;
const NOW = 1_000 * DAY;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => {
  db.close();
});

function item(id: string, service: string, type: string, modifiedAt: number): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, id, modifiedAt, modifiedAt],
  );
}

function candidate(id: string, sourceItemId: string, decidedAt: number): void {
  upsertCandidate(db, {
    id,
    sourceItemId,
    cueTier: "explicit",
    cueText: `cue for ${id}`,
    priority: 0.5,
    decidedAt,
    nowMs: NOW,
  });
}

function extracted(id: string, sourceItemId: string, decidedAt: number, confidence: number): void {
  candidate(id, sourceItemId, decidedAt);
  markExtracted(
    db,
    id,
    { statement: `We decided ${id}`, rationale: null, alternatives: [], extractionSource: "llm" },
    NOW,
  );
  setConfidence(db, id, confidence, false, NOW, "message");
}

/** `null` = no refresher (a default parameter would swallow an explicit `undefined`). */
function status(minConfidence = 0.3, refresherState: "idle" | "running" | null = "idle") {
  return readDecisionStatus(db, {
    mapping: BUILTIN_SOURCE_MAPPING,
    nowMs: NOW,
    minConfidence,
    refresherState: refresherState ?? undefined,
  });
}

describe("readDecisionStatus", () => {
  test("counts only effective decision source types with items in the window, biggest first", () => {
    item("s1", "slack", "message", NOW - DAY);
    item("s2", "slack", "message", NOW - 2 * DAY);
    item("s-old", "slack", "message", NOW - 100 * DAY);
    item("j1", "jira", "issue", NOW - DAY);
    const r = status();
    expect(r.sources).toEqual([
      { service: "slack", type: "message", kind: "message", items: 2 },
      { service: "jira", type: "issue", kind: "ticket", items: 1 },
    ]);
  });

  test("a decision older than the window counts in neither candidates nor shown", () => {
    item("s1", "slack", "message", NOW - 100 * DAY);
    extracted("old", "s1", NOW - 100 * DAY, 0.9);
    const r = status();
    expect(r.candidates).toEqual({ pending: 0, extracted: 0, vetoed: 0 });
    expect(r.shown).toBe(0);
    expect(r.recent).toEqual([]);
  });

  test("shown counts extracted rows at or above minConfidence; candidates count them all", () => {
    item("s1", "slack", "message", NOW - DAY);
    extracted("sure", "s1", NOW - DAY, 0.8);
    extracted("unsure", "s1", NOW - DAY, 0.1);
    candidate("queued", "s1", NOW - DAY);
    const r = status(0.3);
    expect(r.candidates).toEqual({ pending: 1, extracted: 2, vetoed: 0 });
    expect(r.shown).toBe(1);
    expect(r.recent.map((d) => d.statement)).toEqual(["We decided sure"]);
  });

  test("recent is newest first, capped at 5, statement capped at 280, with the source's service", () => {
    item("s1", "slack", "message", NOW - DAY);
    for (let i = 0; i < 7; i++) extracted(`d${String(i)}`, "s1", NOW - (10 - i) * DAY, 0.9);
    const long = "x".repeat(400);
    db.run("UPDATE decision_record SET statement = ? WHERE id = 'd6'", [long]);
    const r = status();
    expect(r.shown).toBe(7);
    expect(r.recent).toHaveLength(5);
    expect(r.recent[0]?.statement).toHaveLength(280);
    expect(r.recent[0]).toMatchObject({ service: "slack", at: NOW - 4 * DAY });
    expect(r.recent[1]?.statement).toBe("We decided d5");
  });

  test("a decision whose source item is gone still shows, with service unknown", () => {
    extracted("orphan", "gone-item", NOW - DAY, 0.9);
    expect(status().recent[0]).toMatchObject({ service: "unknown" });
  });

  test("no refresher → enabled false, state disabled; window and floor are reported", () => {
    const r = status(0.4, null);
    expect(r).toMatchObject({ enabled: false, state: "disabled", minConfidence: 0.4 });
    expect(r.windowDays).toBe(DECISIONS_DEFAULT_WINDOW_MS / DAY);
    expect(r.windowDays).toBe(90);
    expect(r.lastPassAt).toBeNull();
  });

  test("a refresher's state passes through", () => {
    expect(status(0.3, "running")).toMatchObject({ enabled: true, state: "running" });
  });
});
