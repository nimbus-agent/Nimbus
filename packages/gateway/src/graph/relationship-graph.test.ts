import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { deleteItemByPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isItemLinkedGraphType, traverseGraph } from "./relationship-graph.ts";

test("data warehouse/BI item types are graph-participating", () => {
  expect(isItemLinkedGraphType("data_model")).toBe(true);
  expect(isItemLinkedGraphType("dashboard")).toBe(true);
  expect(isItemLinkedGraphType("data_quality_test")).toBe(true);
});

describe("relationship graph (v7)", () => {
  test("PR upsert creates repo, person, and authored/targets edges", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      LocalIndex.SCHEMA_VERSION,
    );

    const personId = "p-test-1";
    db.run(`INSERT INTO person (id, display_name, canonical_email, linked) VALUES (?, ?, ?, 0)`, [
      personId,
      "Alice",
      "alice@example.com",
    ]);

    const now = Date.now();
    const itemId = "github:acme/app#1";
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix login",
      bodyPreview: "patch",
      modifiedAt: now,
      syncedAt: now,
      authorId: personId,
      metadata: { repo: "acme/app", user: "alice" },
    });

    const entities = db
      .query("SELECT type, external_id FROM graph_entity ORDER BY type, external_id")
      .all() as {
      type: string;
      external_id: string;
    }[];
    expect(entities.some((e) => e.type === "pr" && e.external_id === itemId)).toBe(true);
    expect(entities.some((e) => e.type === "repo" && e.external_id === "github:acme/app")).toBe(
      true,
    );
    expect(entities.some((e) => e.type === "person" && e.external_id === personId)).toBe(true);

    const rels = db.query("SELECT type FROM graph_relation ORDER BY type").all() as {
      type: string;
    }[];
    expect(rels.some((r) => r.type === "authored")).toBe(true);
    expect(rels.some((r) => r.type === "targets")).toBe(true);

    const sub = traverseGraph(db, itemId, { depth: 2 });
    expect(sub).not.toHaveProperty("error");
    if (!("error" in sub)) {
      expect(sub.entities.length).toBeGreaterThanOrEqual(3);
      expect(sub.relations.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("deleting item removes pr graph node and leaves shared repo/person", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);

    const personId = "p-test-2";
    db.run(`INSERT INTO person (id, display_name, canonical_email, linked) VALUES (?, ?, ?, 0)`, [
      personId,
      "Bob",
      "bob@example.com",
    ]);

    const now = Date.now();
    const itemId = "github:acme/app#2";
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#2",
      title: "Second",
      modifiedAt: now,
      syncedAt: now,
      authorId: personId,
      metadata: { repo: "acme/app" },
    });

    deleteItemByPrimaryKey(db, itemId);

    const prLeft = db.query("SELECT COUNT(*) AS c FROM graph_entity WHERE type = 'pr'").get() as {
      c: number;
    };
    expect(prLeft.c).toBe(0);
    const repoLeft = db
      .query("SELECT COUNT(*) AS c FROM graph_entity WHERE type = 'repo'")
      .get() as {
      c: number;
    };
    expect(repoLeft.c).toBe(1);
    const personLeft = db
      .query("SELECT COUNT(*) AS c FROM graph_entity WHERE type = 'person'")
      .get() as {
      c: number;
    };
    expect(personLeft.c).toBe(1);
  });
});
