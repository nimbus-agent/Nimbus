import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { GRAPH_V7_MIGRATION_SQL } from "./graph-v7-sql.ts";
import {
  buildNoDownstreamIncidentSql,
  buildNotReviewedSql,
  buildNotTouchingSql,
  countNotTouchingExclusions,
  probeCorrelatesWith,
  probePrFileCoverage,
  probeReviewed,
} from "./negation-predicates.ts";
import { PR_CHANGED_FILE_V55_SQL } from "./pr-changed-file-v55-sql.ts";
import { UNIFIED_ITEM_V3_SCHEMA_SQL } from "./unified-item-v3-sql.ts";

// ---------------------------------------------------------------------------
// File-local test harness. Not exported: importing a `.test.ts` module
// re-executes its `describe`/`test` calls, silently re-running this whole
// suite inside the importer.
// ---------------------------------------------------------------------------

const makeDb = (): Database => {
  const db = new Database(":memory:");
  db.exec(UNIFIED_ITEM_V3_SCHEMA_SQL);
  db.exec(GRAPH_V7_MIGRATION_SQL);
  db.exec(PR_CHANGED_FILE_V55_SQL);
  return db;
};

const insertItem = (db: Database, id: string, type: string): void => {
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?1, 'test', ?2, ?1, ?1, 0, 0)`,
  ).run(id, type);
};

const seedCoveredPr = (
  db: Database,
  id: string,
  paths: readonly string[],
  status = "added",
): void => {
  insertItem(db, id, "pr");
  db.query(
    `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count, truncated)
     VALUES (?1, 0, ?2, ?2, 0)`,
  ).run(id, paths.length);
  const insertFile = db.query(
    `INSERT INTO pr_changed_file (item_id, repo_full, path, status) VALUES (?1, 'test/repo', ?2, ?3)`,
  );
  for (const path of paths) {
    insertFile.run(id, path, status);
  }
};

const seedUncoveredPr = (db: Database, id: string): void => {
  insertItem(db, id, "pr");
};

const seedTruncatedPr = (db: Database, id: string, paths: readonly string[]): void => {
  insertItem(db, id, "pr");
  db.query(
    `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count, truncated)
     VALUES (?1, 0, ?2, ?2, 1)`,
  ).run(id, paths.length);
  const insertFile = db.query(
    `INSERT INTO pr_changed_file (item_id, repo_full, path, status) VALUES (?1, 'test/repo', ?2, 'added')`,
  );
  for (const path of paths) {
    insertFile.run(id, path);
  }
};

const runIds = (db: Database, built: { sql: string; vals: Array<string | number> }): string[] => {
  const rows = db.query(built.sql).all(...built.vals) as Array<{ id: string }>;
  return rows.map((r) => r.id);
};

// -- graph_entity BRIDGE seeds ------------------------------------------------
//
// Neither `item.id` nor `person.id` joins to `graph_relation.from_id` directly:
// the real populator upserts a `graph_entity` whose `external_id` is the
// item/person id and emits edges FROM that entity's own primary key. These
// helpers build exactly that shape, never `from_id = item.id` directly.

let entitySeq = 0;
const nextEntityId = (): string => {
  entitySeq += 1;
  return `entity-${entitySeq}`;
};

const insertGraphEntity = (
  db: Database,
  type: string,
  externalId: string,
  label: string,
): string => {
  const id = nextEntityId();
  db.query(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?1, ?2, ?3, ?4)`).run(
    id,
    type,
    externalId,
    label,
  );
  return id;
};

const insertGraphRelation = (
  db: Database,
  fromEntityId: string,
  toEntityId: string,
  type: string,
  createdAt: number,
): void => {
  db.query(
    `INSERT INTO graph_relation (from_id, to_id, type, weight, created_at)
     VALUES (?1, ?2, ?3, 1.0, ?4)`,
  ).run(fromEntityId, toEntityId, type, createdAt);
};

const seedDeploymentWithIncident = (db: Database, id: string): void => {
  insertItem(db, id, "deployment");
  const deploymentEntityId = insertGraphEntity(db, "deployment", id, id);
  const incidentEntityId = insertGraphEntity(db, "incident", `inc-${id}`, `inc-${id}`);
  insertGraphRelation(db, deploymentEntityId, incidentEntityId, "correlates_with", 0);
};

const seedDeploymentWithoutIncident = (db: Database, id: string): void => {
  insertItem(db, id, "deployment");
  insertGraphEntity(db, "deployment", id, id);
};

const seedPersonWithReview = (db: Database, id: string, createdAt: number): void => {
  db.query(`INSERT INTO person (id, display_name) VALUES (?1, ?1)`).run(id);
  const personEntityId = insertGraphEntity(db, "person", id, id);
  const prEntityId = insertGraphEntity(db, "pr", `pr-${id}`, `pr-${id}`);
  insertGraphRelation(db, personEntityId, prEntityId, "reviewed", createdAt);
};

const seedPersonWithoutReview = (db: Database, id: string): void => {
  db.query(`INSERT INTO person (id, display_name) VALUES (?1, ?1)`).run(id);
  insertGraphEntity(db, "person", id, id);
};

describe("substrate probes", () => {
  test("probePrFileCoverage fails on an empty coverage table", () => {
    const db = makeDb();
    const p = probePrFileCoverage(db);
    expect(p.passed).toBe(false);
    expect(p.rowCount).toBe(0);
    expect(p.probeSql).toContain("pr_files_state");
    db.close();
  });

  test("probePrFileCoverage passes once one PR is covered", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    expect(probePrFileCoverage(db).passed).toBe(true);
    db.close();
  });

  test("probeReviewed and probeCorrelatesWith fail on an empty graph", () => {
    const db = makeDb();
    expect(probeReviewed(db).passed).toBe(false);
    expect(probeCorrelatesWith(db).passed).toBe(false);
    db.close();
  });
});

describe("buildNotTouchingSql", () => {
  test("excludes a PR that touches the glob", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["tests/a.ts"]);
    seedCoveredPr(db, "p2", ["src/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p2"]);
    db.close();
  });

  test("a PR with NO coverage row is excluded, not returned", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    seedUncoveredPr(db, "p2");
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p1"]);
    expect(countNotTouchingExclusions(db).excludedNoCoverage).toBe(1);
    db.close();
  });

  test("a TRUNCATED PR is excluded on the same footing as an uncovered one", () => {
    const db = makeDb();
    seedTruncatedPr(db, "p1", ["src/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual([]);
    expect(countNotTouchingExclusions(db).excludedTruncated).toBe(1);
    db.close();
  });

  test("matching is case-sensitive - Tests/ does not answer a tests/ question", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["Tests/a.ts"]);
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual(["p1"]);
    db.close();
  });

  test("an underscore in the pattern is literal, not a wildcard", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["src/myXfile.ts"]);
    expect(runIds(db, buildNotTouchingSql("src/my_file.ts"))).toEqual(["p1"]);
    db.close();
  });

  test("a PR that DELETED a matching file still counts as touching it", () => {
    const db = makeDb();
    seedCoveredPr(db, "p1", ["tests/gone.ts"], "removed");
    expect(runIds(db, buildNotTouchingSql("tests/*"))).toEqual([]);
    db.close();
  });
});

// The graph_entity BRIDGE is the highest-consequence join in this plan, and a wrong one fails
// SILENTLY in the dangerous direction: no edges found means every deployment looks clean, and
// every person looks like they never reviewed. These tests exist to make a wrong join loud.
describe("buildNoDownstreamIncidentSql", () => {
  test("a deployment WITH a correlates_with edge is excluded", () => {
    const db = makeDb();
    seedDeploymentWithIncident(db, "d1");
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual([]);
    db.close();
  });

  test("a deployment with no edge is returned", () => {
    const db = makeDb();
    seedDeploymentWithoutIncident(db, "d2");
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual(["d2"]);
    db.close();
  });

  test("an incident's own edge does not make the incident look like a clean deployment", () => {
    const db = makeDb();
    seedDeploymentWithIncident(db, "d1");
    // Only `type = 'deployment'` rows may ever appear, whatever else the graph holds.
    expect(runIds(db, buildNoDownstreamIncidentSql())).toEqual([]);
    db.close();
  });
});

describe("buildNotReviewedSql", () => {
  test("a person WITH a recent reviewed edge is excluded", () => {
    const db = makeDb();
    seedPersonWithReview(db, "alice", 5_000);
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual([]);
    db.close();
  });

  test("a person with no reviewed edge is returned", () => {
    const db = makeDb();
    seedPersonWithoutReview(db, "bob");
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual(["bob"]);
    db.close();
  });

  test("a review OLDER than the cutoff does not count - the person is returned", () => {
    const db = makeDb();
    seedPersonWithReview(db, "carol", 500);
    expect(runIds(db, buildNotReviewedSql(1_000))).toEqual(["carol"]);
    db.close();
  });
});
