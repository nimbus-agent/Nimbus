import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { discoverClosedEpics } from "./theme-discover.ts";

function seedEpic(
  db: Database,
  p: {
    id: string;
    modifiedAt: number;
    statusCategory: string;
    issueType?: string;
    body?: string;
    bodyComplete?: number;
    resolvedAtMs?: number;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, ?, ?, ?, 1, 0)`,
    [
      p.id,
      p.id.split(":")[1] ?? p.id,
      p.body ?? "some body",
      p.bodyComplete ?? 1,
      JSON.stringify({
        meta_v: 1,
        status_category: p.statusCategory,
        issue_type: p.issueType ?? "Epic",
        resolved_at_ms: p.resolvedAtMs ?? 5000,
      }),
      p.modifiedAt,
    ],
  );
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

test("discovers only CLOSED epics", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 11, statusCategory: "canceled" });
  seedEpic(db, { id: "jira:C", modifiedAt: 12, statusCategory: "in_progress" });
  seedEpic(db, { id: "jira:D", modifiedAt: 13, statusCategory: "unknown" });

  const found = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found.map((e) => e.itemId).sort()).toEqual(["jira:A", "jira:B"]);
  db.close();
});

test("skips non-epic issues", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done", issueType: "Bug" });
  expect(discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 })).toEqual([]);
  db.close();
});

test("resumes strictly after the composite watermark", () => {
  // Three rows share modified_at = 10. Resuming on watermark_ms alone would
  // either re-scan all three or skip the two after the tie.
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:C", modifiedAt: 10, statusCategory: "done" });

  const found = discoverClosedEpics(db, {
    watermarkMs: 10,
    watermarkId: "jira:A",
    batchSize: 50,
  });
  expect(found.map((e) => e.itemId)).toEqual(["jira:B", "jira:C"]);
  db.close();
});

test("respects batchSize and returns rows in watermark order", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:C", modifiedAt: 30, statusCategory: "done" });
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  seedEpic(db, { id: "jira:B", modifiedAt: 20, statusCategory: "done" });

  const found = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 2 });
  expect(found.map((e) => e.itemId)).toEqual(["jira:A", "jira:B"]);
  db.close();
});

test("reports body truncation so the brief can count it", () => {
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done", bodyComplete: 0 });
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.bodyComplete).toBe(false);
  db.close();
});

test("exposes the epic key children point at, and no connector service field", () => {
  // `epicKey` feeds affectedServicesForEpic. There is deliberately no `service`
  // field: a theme's service is the AFFECTED service, and surfacing the
  // connector one here is how that distinction gets lost.
  const db = freshDb();
  seedEpic(db, { id: "jira:A", modifiedAt: 10, statusCategory: "done" });
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.epicKey).toBe("A");
  expect(found).not.toHaveProperty("service");
  db.close();
});

test("a missing resolved_at_ms is absent, never 0", () => {
  // Same rule the ticket-depth contract set: 0 would read as 1970, and a
  // consumer must be able to tell "unresolved" from "resolved at the epoch".
  const db = freshDb();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body, body_complete,
                       metadata, modified_at, synced_at, pinned)
     VALUES ('jira:N', 'jira', 'issue', 'N', 'T', 'b', 1, ?, 10, 1, 0)`,
    [JSON.stringify({ meta_v: 1, status_category: "done", issue_type: "Epic" })],
  );
  const [found] = discoverClosedEpics(db, { watermarkMs: 0, watermarkId: "", batchSize: 50 });
  expect(found?.resolvedAtMs).toBeUndefined();
  db.close();
});
