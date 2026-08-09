import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  demoteThemesWithNoLiveEvidence,
  pruneOrphanedEvidence,
  readPassState,
  themesForServices,
  upsertTheme,
  writePassState,
} from "./theme-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  // Evidence liveness is checked against `item`, so seed one real row.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES ('jira:PROJ-1', 'jira', 'issue', 'PROJ-1', 'T', 1, 1, 0)`,
  );
  return db;
}

test("upsert is idempotent on (service, normalized label) and accumulates evidence", () => {
  const db = freshDb();
  const a = upsertTheme(db, {
    service: "acme/billing-api",
    label: "Rate limits.",
    nowMs: 100,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-1", label: "PROJ-1" }],
  });
  const b = upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate  limits",
    nowMs: 200,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-2", label: "PROJ-2" }],
  });
  expect(b).toBe(a);

  const [theme] = themesForServices(db, ["acme/billing-api"]);
  expect(theme?.evidenceCount).toBe(2);
  // Confidence tracks the accumulated count, not the last write.
  expect(theme?.confidence).toBeGreaterThan(0);
  expect(theme?.lastSeenAt).toBe(200);
  db.close();
});

test("re-supplying the same evidence key does not inflate the count", () => {
  const db = freshDb();
  const ev = [{ itemId: "jira:PROJ-1", evidenceKey: "jira:PROJ-1", label: "PROJ-1" }];
  upsertTheme(db, { service: "acme/billing-api", label: "rate limits", nowMs: 1, evidence: ev });
  upsertTheme(db, { service: "acme/billing-api", label: "rate limits", nowMs: 2, evidence: ev });
  const [theme] = themesForServices(db, ["acme/billing-api"]);
  expect(theme?.evidenceCount).toBe(1);
  db.close();
});

test("themesForServices is service-scoped and skips demoted rows", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k1", label: "PROJ-1" }],
  });
  upsertTheme(db, {
    service: "search",
    label: "index rebuilds",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k2", label: "PROJ-1" }],
  });
  expect(themesForServices(db, ["acme/billing-api"]).map((t) => t.service)).toEqual([
    "acme/billing-api",
  ]);
  expect(themesForServices(db, ["acme/billing-api", "search"])).toHaveLength(2);
  expect(themesForServices(db, [])).toEqual([]);
  db.close();
});

test("a theme whose every source item is gone is demoted, not deleted", () => {
  // Demote rather than delete: the row is the durable record of extraction
  // budget already spent, and deleting it would re-mine the same theme on the
  // next pass.
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:GONE", evidenceKey: "k1", label: "GONE" }],
  });
  const demoted = demoteThemesWithNoLiveEvidence(db, 500);
  expect(demoted).toBe(1);
  expect(themesForServices(db, ["acme/billing-api"])).toEqual([]);
  const row = db.query(`SELECT status FROM premortem_theme`).get() as { status: string };
  expect(row.status).toBe("demoted");
  db.close();
});

test("a theme with at least one live source survives the sweep", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [
      { itemId: "jira:GONE", evidenceKey: "k1", label: "GONE" },
      { itemId: "jira:PROJ-1", evidenceKey: "k2", label: "PROJ-1" },
    ],
  });
  expect(demoteThemesWithNoLiveEvidence(db, 500)).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])).toHaveLength(1);
  db.close();
});

test("pruning removes dead evidence rows and lowers the theme's confidence", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [
      { itemId: "jira:PROJ-1", evidenceKey: "k1", label: "live" },
      { itemId: "jira:GONE", evidenceKey: "k2", label: "dead" },
    ],
  });
  const before = themesForServices(db, ["acme/billing-api"])[0]?.confidence ?? 0;

  expect(pruneOrphanedEvidence(db)).toBe(1);

  const after = themesForServices(db, ["acme/billing-api"])[0];
  expect(after?.evidenceCount).toBe(1);
  // Corroboration the user can no longer inspect must not still be counted.
  expect(after?.confidence).toBeLessThan(before);
  db.close();
});

test("pruning is a no-op when every source is live", () => {
  const db = freshDb();
  upsertTheme(db, {
    service: "acme/billing-api",
    label: "rate limits",
    nowMs: 1,
    evidence: [{ itemId: "jira:PROJ-1", evidenceKey: "k1", label: "live" }],
  });
  expect(pruneOrphanedEvidence(db)).toBe(0);
  expect(themesForServices(db, ["acme/billing-api"])[0]?.evidenceCount).toBe(1);
  db.close();
});

test("pass state round-trips the composite watermark", () => {
  const db = freshDb();
  expect(readPassState(db)).toEqual({ watermarkMs: 0, watermarkId: "" });
  writePassState(db, {
    watermarkMs: 42,
    watermarkId: "jira:PROJ-9",
    nowMs: 100,
    newThemes: 3,
    scanned: 7,
  });
  expect(readPassState(db)).toEqual({ watermarkMs: 42, watermarkId: "jira:PROJ-9" });
  db.close();
});

test('readPassState falls back to (0, "") rather than throwing when the singleton row is gone', () => {
  // V53 seeds `premortem_pass_state` with `INSERT OR IGNORE`, so the row is
  // never absent in normal operation — but a corrupted or manually-truncated
  // table must not crash the pass; it must resume from the start instead.
  const db = freshDb();
  db.run(`DELETE FROM premortem_pass_state`);
  expect(readPassState(db)).toEqual({ watermarkMs: 0, watermarkId: "" });
  db.close();
});
