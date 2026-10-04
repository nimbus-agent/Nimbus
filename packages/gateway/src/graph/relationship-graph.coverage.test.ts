import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import {
  deleteGraphEntitiesForItemKeys,
  ensureGraphEntity,
  traverseGraph,
  upsertGraphEntity,
  upsertGraphRelation,
} from "./relationship-graph.ts";

/**
 * Two bounds `relationship-graph.test.ts` never reaches: deleting graph entities for an EMPTY key
 * list, and `traverseGraph`'s `maxNodes` budget, which stops enqueueing neighbours once it is
 * spent — while still reporting every edge it saw from a visited node.
 *
 * The empty-list guard is NOT what keeps the SQL valid: SQLite accepts `IN ()` and matches
 * nothing. Its observable effect is that an empty list issues no statement at all, so that is
 * what the test pins — on a database with no graph tables, where any statement would throw.
 */

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function makeDb(): Database {
  const db = new Database(":memory:");
  dbs.push(db);
  LocalIndex.ensureSchema(db);
  return db;
}

describe("deleteGraphEntitiesForItemKeys", () => {
  test("an empty key list issues no statement at all — a no-op even without the graph tables", () => {
    const bare = new Database(":memory:");
    dbs.push(bare);

    expect(() => deleteGraphEntitiesForItemKeys(bare, [])).not.toThrow();
    // Positive control: the same database rejects a real delete, so the no-op above is the
    // guard's doing and not an accident of the schema.
    expect(() => deleteGraphEntitiesForItemKeys(bare, ["github:acme/app#1"])).toThrow(
      "no such table: graph_entity",
    );
  });

  test("a non-empty list deletes only the item-linked entities it names (positive control)", () => {
    const db = makeDb();
    upsertGraphEntity(db, { type: "pr", externalId: "github:acme/app#1", label: "PR 1" });
    upsertGraphEntity(db, { type: "pr", externalId: "github:acme/app#2", label: "PR 2" });
    ensureGraphEntity(db, { type: "repo", externalId: "github:acme/app", label: "acme/app" });

    deleteGraphEntitiesForItemKeys(db, ["github:acme/app#1", "github:acme/app"]);

    const left = (
      db.query("SELECT external_id FROM graph_entity ORDER BY external_id").all() as Array<{
        external_id: string;
      }>
    ).map((r) => r.external_id);
    // The repo is not an item-linked type, so naming its id does not delete it.
    expect(left).toEqual(["github:acme/app", "github:acme/app#2"]);
  });
});

describe("traverseGraph — the maxNodes budget", () => {
  function star(db: Database): { center: string; spokes: string[] } {
    const center = ensureGraphEntity(db, {
      type: "repo",
      externalId: "github:acme/hub",
      label: "hub",
    });
    const spokes = ["a", "b", "c"].map((s) => {
      const id = upsertGraphEntity(db, {
        type: "pr",
        externalId: `github:acme/hub#${s}`,
        label: s,
      });
      upsertGraphRelation(db, id, center, "targets", 1_000);
      return id;
    });
    return { center, spokes };
  }

  test("stops visiting new nodes once the budget is spent, but reports every edge it walked", () => {
    const db = makeDb();
    const { center, spokes } = star(db);

    const out = traverseGraph(db, "github:acme/hub", { maxNodes: 2, depth: 2 });

    if ("error" in out) throw new Error(out.error);
    expect(out.startEntityId).toBe(center);
    // The centre plus exactly one spoke fit the budget of 2.
    expect(out.entities).toHaveLength(2);
    expect(out.entities.map((e) => e.id)).toContain(center);
    // All three spoke edges touch the visited centre, so all three are reported.
    const byId = (a: string, b: string): number => a.localeCompare(b);
    expect(out.relations.map((r) => r.from_id).sort(byId)).toEqual([...spokes].sort(byId));
  });

  test("with room to spare every spoke is visited (positive control)", () => {
    const db = makeDb();
    const { spokes } = star(db);

    const out = traverseGraph(db, "github:acme/hub", { maxNodes: 10, depth: 2 });

    if ("error" in out) throw new Error(out.error);
    expect(out.entities).toHaveLength(1 + spokes.length);
  });
});
