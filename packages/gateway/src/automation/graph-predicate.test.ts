import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { LocalIndex } from "../index/local-index.ts";
import {
  countItemsMatchingGraphPredicate,
  GRAPH_RELATION_KINDS,
  itemMatchesGraphPredicate,
  listCandidateGraphRelations,
  parseGraphPredicate,
} from "./graph-predicate.ts";

describe("parseGraphPredicate", () => {
  test("accepts a well-formed owned_by predicate with a person target", () => {
    const raw = JSON.stringify({
      relation: "owned_by",
      target: { type: "person", externalId: "gh:42" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.predicate.relation).toBe("owned_by");
      expect(parsed.predicate.target).toEqual({ type: "person", externalId: "gh:42" });
    }
  });

  test("accepts upstream_of with a generic entity target", () => {
    const raw = JSON.stringify({
      relation: "upstream_of",
      target: { type: "repo", externalId: "github:acme/svc" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(true);
  });

  test("accepts downstream_of", () => {
    const raw = JSON.stringify({
      relation: "downstream_of",
      target: { type: "repo", externalId: "github:acme/svc" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(true);
  });

  test("rejects malformed JSON", () => {
    const parsed = parseGraphPredicate("not json");
    expect(parsed.ok).toBe(false);
  });

  test("rejects unknown relation kind", () => {
    const raw = JSON.stringify({
      relation: "bogus",
      target: { type: "person", externalId: "x" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
  });

  test("rejects empty externalId", () => {
    const raw = JSON.stringify({
      relation: "owned_by",
      target: { type: "person", externalId: "" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
  });

  test("rejects missing target", () => {
    const raw = JSON.stringify({ relation: "owned_by" });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
  });

  test("rejects non-string target type", () => {
    const raw = JSON.stringify({
      relation: "owned_by",
      target: { type: 42, externalId: "x" },
    });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
  });

  test("rejects top-level JSON that is not an object (e.g. array)", () => {
    const parsed = parseGraphPredicate("[]");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/JSON object/);
    }
  });

  test("rejects top-level JSON that is not an object (e.g. null)", () => {
    const parsed = parseGraphPredicate("null");
    expect(parsed.ok).toBe(false);
  });

  test("rejects target that is not an object (e.g. string)", () => {
    const raw = JSON.stringify({ relation: "owned_by", target: "not-an-object" });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/must be an object/);
    }
  });

  test("rejects target that is an array", () => {
    const raw = JSON.stringify({ relation: "owned_by", target: ["person", "gh:42"] });
    const parsed = parseGraphPredicate(raw);
    expect(parsed.ok).toBe(false);
  });
});

describe("listCandidateGraphRelations", () => {
  test("returns exactly the three logical relation kinds", () => {
    const kinds = listCandidateGraphRelations();
    expect(kinds).toHaveLength(3);
    expect(kinds.map((k) => k.relation).sort((a, b) => a.localeCompare(b))).toEqual([
      "downstream_of",
      "owned_by",
      "upstream_of",
    ]);
  });

  test("exposes an underlying-relation-type mapping per kind", () => {
    const kinds = listCandidateGraphRelations();
    for (const k of kinds) {
      expect(k.underlyingRelationTypes.length).toBeGreaterThan(0);
      for (const t of k.underlyingRelationTypes) {
        expect(typeof t).toBe("string");
        expect(t.length).toBeGreaterThan(0);
      }
    }
  });

  test("GRAPH_RELATION_KINDS and listCandidateGraphRelations agree", () => {
    const listed = listCandidateGraphRelations()
      .map((k) => k.relation)
      .sort((a, b) => a.localeCompare(b));
    const kinds = [...GRAPH_RELATION_KINDS].sort((a, b) => a.localeCompare(b));
    expect(listed).toEqual(kinds);
  });
});

function seededDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedPersonAndPr(db: Database): { personId: string; prId: string } {
  return {
    personId: upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:42",
      label: "Dev",
      service: "github",
    }),
    prId: upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-1",
      label: "Fix bug",
      service: "github",
    }),
  };
}

describe("itemMatchesGraphPredicate", () => {
  test("owned_by matches when person authored the item", () => {
    const db = seededDb();
    const now = 1_700_000_000_000;
    const { personId, prId } = seedPersonAndPr(db);
    upsertGraphRelation(db, personId, prId, "authored", now);

    const matched = itemMatchesGraphPredicate({
      db,
      itemEntityType: "pr",
      itemExternalId: "pr-1",
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:42" },
      },
    });
    expect(matched).toBe(true);
  });

  test("owned_by rejects when relation type is not an ownership type", () => {
    const db = seededDb();
    const now = 1_700_000_000_000;
    const { personId, prId } = seedPersonAndPr(db);
    upsertGraphRelation(db, personId, prId, "reviewed", now);

    const matched = itemMatchesGraphPredicate({
      db,
      itemEntityType: "pr",
      itemExternalId: "pr-1",
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:42" },
      },
    });
    expect(matched).toBe(false);
  });

  test("upstream_of matches an item → target outgoing edge", () => {
    const db = seededDb();
    const now = 1_700_000_000_000;
    const prId = upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-2",
      label: "PR",
      service: "github",
    });
    const repoId = upsertGraphEntity(db, {
      type: "repo",
      externalId: "github:acme/svc",
      label: "acme/svc",
      service: "github",
    });
    upsertGraphRelation(db, prId, repoId, "targets", now);

    const matched = itemMatchesGraphPredicate({
      db,
      itemEntityType: "pr",
      itemExternalId: "pr-2",
      predicate: {
        relation: "upstream_of",
        target: { type: "repo", externalId: "github:acme/svc" },
      },
    });
    expect(matched).toBe(true);
    expect(
      itemMatchesGraphPredicate({
        db,
        itemEntityType: "pr",
        itemExternalId: "pr-2",
        predicate: {
          relation: "downstream_of",
          target: { type: "repo", externalId: "github:acme/svc" },
        },
      }),
    ).toBe(false);
  });

  test("downstream_of matches a target → item edge", () => {
    const db = seededDb();
    const now = 1_700_000_000_000;
    const wsId = upsertGraphEntity(db, {
      type: "workspace",
      externalId: "filesystem:/repo",
      label: "/repo",
      service: "filesystem",
    });
    const depId = upsertGraphEntity(db, {
      type: "package",
      externalId: "npm:left-pad@1.0.0",
      label: "left-pad@1.0.0",
      service: "filesystem",
    });
    upsertGraphRelation(db, wsId, depId, "depends_on", now);

    const matched = itemMatchesGraphPredicate({
      db,
      itemEntityType: "package",
      itemExternalId: "npm:left-pad@1.0.0",
      predicate: {
        relation: "downstream_of",
        target: { type: "workspace", externalId: "filesystem:/repo" },
      },
    });
    expect(matched).toBe(true);
  });

  test("returns false when item entity is missing from the graph", () => {
    const db = seededDb();
    const matched = itemMatchesGraphPredicate({
      db,
      itemEntityType: "pr",
      itemExternalId: "does-not-exist",
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:42" },
      },
    });
    expect(matched).toBe(false);
  });
});

describe("countItemsMatchingGraphPredicate", () => {
  test("returns zero when no items match", () => {
    const db = seededDb();
    const n = countItemsMatchingGraphPredicate({
      db,
      sinceMs: 0,
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:unknown" },
      },
    });
    expect(n).toBe(0);
  });

  test("respects custom maxScan override", () => {
    const db = seededDb();
    const t0 = 1_700_000_000_000;

    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
         VALUES (?, 'github', 'pr', ?, ?, ?, ?)`,
        [`scan-${i}`, `scan-pr-${i}`, `PR ${i}`, t0 + i + 1, t0 + i + 1],
      );
    }

    const n = countItemsMatchingGraphPredicate({
      db,
      sinceMs: t0,
      maxScan: 1,
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:scan-none" },
      },
    });
    expect(n).toBe(0);
  });

  test("counts only items within the time window that match", () => {
    const db = seededDb();
    const t0 = 1_700_000_000_000;

    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('i1', 'github', 'pr', 'pr-old', 'old', ?, ?)`,
      [t0 - 10_000, t0 - 10_000],
    );
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES ('i2', 'github', 'pr', 'pr-new', 'new', ?, ?)`,
      [t0 + 10_000, t0 + 10_000],
    );
    const personId = upsertGraphEntity<string>(db, {
      type: "person",
      externalId: "gh:7",
      label: "Dev",
      service: "github",
    });
    const oldPrId = upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-old",
      label: "old",
      service: "github",
    });
    const newPrId = upsertGraphEntity(db, {
      type: "pr",
      externalId: "pr-new",
      label: "new",
      service: "github",
    });
    upsertGraphRelation(db, personId, oldPrId, "authored", t0);
    upsertGraphRelation(db, personId, newPrId, "authored", t0);

    const n = countItemsMatchingGraphPredicate({
      db,
      sinceMs: t0,
      predicate: {
        relation: "owned_by",
        target: { type: "person", externalId: "gh:7" },
      },
    });
    expect(n).toBe(1);
  });
});
