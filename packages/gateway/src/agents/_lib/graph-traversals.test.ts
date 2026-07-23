import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../../index/local-index.ts";
import { reverseDependsOn } from "./graph-traversals.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

test("returns entities that depend on the target, defaulting service to filesystem", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES " +
      "('t', 'symbol', 'filesystem:t', 'target', NULL, '{}')," +
      "('d', 'symbol', 'filesystem:d', 'dependent', NULL, '{}')",
  );
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES ('d', 't', 'depends_on', 1.0, 0)",
  );
  expect(reverseDependsOn(db, "t")).toEqual([
    { entityId: "d", label: "dependent", serviceId: "filesystem" },
  ]);
});

test("a dangling relation yields no row (INNER JOIN)", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('t', 'symbol', 'filesystem:t', 'target', NULL, '{}')",
  );
  // No 'ghost' entity row; FK would normally forbid this, so insert with FKs off to simulate drift.
  db.run("PRAGMA foreign_keys = OFF");
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES ('ghost', 't', 'depends_on', 1.0, 0)",
  );
  expect(reverseDependsOn(db, "t")).toEqual([]);
});

test("respects the limit", () => {
  const db = freshDb();
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES ('t', 'symbol', 'x:t', 't', NULL, '{}')",
  );
  for (let i = 0; i < 5; i++) {
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'symbol', ?, ?, NULL, '{}')",
      [`d${String(i)}`, `x:d${String(i)}`, `dep${String(i)}`],
    );
    db.run(
      "INSERT INTO graph_relation (from_id, to_id, type, weight, created_at) VALUES (?, 't', 'depends_on', 1.0, 0)",
      [`d${String(i)}`],
    );
  }
  expect(reverseDependsOn(db, "t", 2)).toHaveLength(2);
});
