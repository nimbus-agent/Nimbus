import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { loadDecisionCandidates, runDecisionPass } from "./decision-extract.ts";
import { listDecisions } from "./decision-store.ts";

function freshDb(): Database {
  const d = new Database(":memory:");
  runIndexedSchemaMigrations(d, CURRENT_SCHEMA_VERSION);
  return d;
}

// The brief's honesty count: `loadDecisionCandidates` scans the FULL
// decision-source domain within a window (not the incremental delta the
// mining pass drains) and reports how many of those sources are indexed with
// a truncated body (`body_complete = 0`) — either a connector that has not
// declared a full body yet, or one that did but the source exceeded its
// type's cap.
test("candidate loading reports how many source bodies were truncated", () => {
  const d = freshDb();

  // Complete: a short declared-full body.
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "complete",
    title: "t1",
    body: "we decided to move billing to Postgres because the pool kept exhausting",
    modifiedAt: 2,
    syncedAt: 1,
  });

  // Incomplete: the legacy preview path never claims completeness.
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "truncated",
    title: "t2",
    bodyPreview: "we decided to shard instead; alternatives were read replicas",
    modifiedAt: 1,
    syncedAt: 1,
  });

  const loaded = loadDecisionCandidates(d, { sinceMs: 0 });

  expect(loaded.rows).toHaveLength(2);
  expect(loaded.truncatedSources).toBe(1);
  d.close();
});

test("an item outside the source-type allowlist is not counted as a candidate", () => {
  const d = freshDb();
  upsertIndexedItem(d, {
    service: "wiz",
    type: "issue",
    externalId: "finding",
    title: "t1",
    bodyPreview: "we decided to accept this risk",
    modifiedAt: 1,
    syncedAt: 1,
  });
  const loaded = loadDecisionCandidates(d, { sinceMs: 0 });
  expect(loaded.rows).toHaveLength(0);
  expect(loaded.truncatedSources).toBe(0);
});

test("an item older than sinceMs is excluded from the candidate load", () => {
  const d = freshDb();
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "old",
    title: "t1",
    bodyPreview: "we decided long ago",
    modifiedAt: 100,
    syncedAt: 1,
  });
  const loaded = loadDecisionCandidates(d, { sinceMs: 200 });
  expect(loaded.rows).toHaveLength(0);
});

// Guards the hidden-clamp pattern this feature hit twice already (Jira,
// Zoom): a `bodyPreview:` -> `body:` substitution is a no-op if something
// upstream still slices to 512 before mining reads it. This fixture is over
// 512 characters, with the cue sentence placed AFTER the old cap, so the
// discovery pass can only find it by reading the full stored body.
const PADDING = "Filler context about the meeting agenda and attendees. ".repeat(12); // > 512 chars
test("discovery mines a cue past the old 512-character mark from the full stored body", () => {
  expect(PADDING.length).toBeGreaterThan(512);
  const d = freshDb();
  upsertIndexedItem(d, {
    service: "slack",
    type: "message",
    externalId: "long-thread",
    title: "thread",
    body: `${PADDING}We decided to move billing to Postgres.`,
    modifiedAt: 5_000,
    syncedAt: 5_000,
  });

  return runDecisionPass(d, {
    nowMs: 10_000,
    useLlm: false,
    maxLlmCalls: 25,
    retryCooldownMs: 1_000,
  }).then((summary) => {
    expect(summary.discovered).toBe(1);
    expect(summary.extracted).toBe(1);
    const [row] = listDecisions(d, { sinceMs: 0, minConfidence: 0, limit: 10 });
    expect(row?.statement).toBe("We decided to move billing to Postgres.");
    d.close();
  });
});
