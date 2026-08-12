import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedErrorIssue(db: Database, id: string, project: string | null): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: `Issue ${id}`,
    body: "boom",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId: null,
    metadata: { org: "acme", project },
  });
}

test("an indexed Sentry issue becomes an error_issue graph entity", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const row = db
    .query<{ type: string; label: string; service: string | null }, []>(
      "SELECT type, label, service FROM graph_entity WHERE type = 'error_issue'",
    )
    .get();
  expect(row?.type).toBe("error_issue");
  expect(row?.label).toBe("Issue 4711");
  expect(row?.service).toBe("sentry");
  db.close();
});

test("the issue belongs_to a service entity keyed on its project slug", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const rel = db
    .query<{ type: string; label: string }, []>(
      `SELECT r.type AS type, te.label AS label
         FROM graph_relation r
         JOIN graph_entity fe ON fe.id = r.from_id AND fe.type = 'error_issue'
         JOIN graph_entity te ON te.id = r.to_id
        WHERE r.type = 'belongs_to'`,
    )
    .get();
  expect(rel?.type).toBe("belongs_to");
  expect(rel?.label).toBe("web");
  db.close();
});

test("an issue with no project slug still yields an entity and no belongs_to edge", () => {
  const db = freshDb();
  seedErrorIssue(db, "4712", null);
  const entity = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'error_issue'")
    .get();
  const rels = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'")
    .get();
  expect(entity?.n).toBe(1);
  expect(rels?.n).toBe(0);
  db.close();
});

// SPEC A ATTRIBUTES NOTHING.
test("no person edge is emitted for an error_issue", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  const n = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'`,
    )
    .get();
  expect(n?.n).toBe(0);
  db.close();
});

// RE-SYNC IDEMPOTENCE. clearRelationsTouchingEntity runs on every pass.
test("re-indexing the same issue does not duplicate its belongs_to edge", () => {
  const db = freshDb();
  seedErrorIssue(db, "4711", "web");
  seedErrorIssue(db, "4711", "web");
  const n = db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'belongs_to'")
    .get();
  expect(n?.n).toBe(1);
  db.close();
});
