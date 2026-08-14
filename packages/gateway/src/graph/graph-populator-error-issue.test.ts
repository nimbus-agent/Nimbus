import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { regraphAllItems } from "./regraph.ts";

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

function assignedEdges(db: Database): Array<{ from_ext: string; to_ext: string }> {
  return db
    .query(
      `SELECT pe.external_id AS from_ext, ie.external_id AS to_ext
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'error_issue'
        WHERE r.type = 'assigned'
        ORDER BY pe.external_id`,
    )
    .all() as Array<{ from_ext: string; to_ext: string }>;
}

function indexErrorIssue(db: Database, id: string, assignedTo: unknown): void {
  upsertIndexedItem(db, {
    service: "sentry",
    type: "error_issue",
    externalId: id,
    title: `TypeError in ${id}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    metadata: { org: "acme", project: "checkout", assignedTo },
  });
}

test("a user-assigned sentry issue gets a person --assigned--> error_issue edge", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-1", {
    type: "user",
    id: "42",
    name: "Jane Doe",
    email: "jane@example.com",
  });

  const edges = assignedEdges(db);
  expect(edges).toHaveLength(1);
  expect(edges[0]?.to_ext).toBe("sentry:SENTRY-1");
  // The person side MUST be the person.id — negotiate matches `pe.external_id = ?`
  // against a person id, so any other encoding silently breaks the reader.
  const person = db
    .query("SELECT id FROM person WHERE canonical_email = 'jane@example.com'")
    .get() as { id: string };
  expect(edges[0]?.from_ext).toBe(person.id);
});

// A team actor is not a person. Sentry allows assigning to a team, and a team
// has no canonical email — minting a person row for one would pollute every
// people-based brief.
test("a team-assigned issue produces no edge and no person row", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-2", { type: "team", id: "7", name: "platform" });
  expect(assignedEdges(db)).toHaveLength(0);
  const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
  expect(n.n).toBe(0);
});

// §4.4: the presence of `email` on a user actor is UNVERIFIED against a real
// Sentry response. Fail closed, and prove it fails closed.
test.each([
  ["null assignedTo", null],
  ["a user actor with no email", { type: "user", id: "42", name: "Jane" }],
  ["a user actor with a junk email", { type: "user", id: "42", email: "unknown" }],
  ["a bare string", "jane@example.com"],
  ["a number", 42],
  // Pins the `type === "user"` guard itself: a team actor CARRYING an email is
  // the one shape that would produce a WRONG edge (a team's address resolving
  // to a person row) rather than merely no edge, if the guard were removed.
  ["a team actor that carries an email", { type: "team", id: "7", email: "team@example.com" }],
])("emits nothing for %s", (_label, assignedTo) => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-3", assignedTo);
  expect(assignedEdges(db)).toHaveLength(0);
  const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
  expect(n.n).toBe(0);
});

// `assigned` is not a CROSS_ITEM type, so the existing clear retires it.
test("re-assigning an issue retires the previous edge", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-4", { type: "user", id: "1", email: "jane@example.com" });
  expect(assignedEdges(db)).toHaveLength(1);

  indexErrorIssue(db, "SENTRY-4", { type: "user", id: "2", email: "bob@example.com" });
  const edges = assignedEdges(db);
  expect(edges).toHaveLength(1);
  const bob = db.query("SELECT id FROM person WHERE canonical_email = 'bob@example.com'").get() as {
    id: string;
  };
  expect(edges[0]?.from_ext).toBe(bob.id);
});

// The whole reason this PR needs no re-sync: attribution rebuilds from rows
// already in the index, with no network.
test("regraph rebuilds attribution from stored rows alone", () => {
  const db = freshDb();
  indexErrorIssue(db, "SENTRY-5", { type: "user", id: "1", email: "jane@example.com" });
  expect(assignedEdges(db)).toHaveLength(1);

  db.run("DELETE FROM graph_relation");
  db.run("DELETE FROM graph_entity");
  expect(assignedEdges(db)).toHaveLength(0);

  regraphAllItems(db);
  expect(assignedEdges(db)).toHaveLength(1);
});
