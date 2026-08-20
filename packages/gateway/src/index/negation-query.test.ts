import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertGraphEntity, upsertGraphRelation } from "../graph/relationship-graph.ts";
import { recordPrChangedFiles } from "../prfiles/pr-changed-file-store.ts";
import { LocalIndex } from "./local-index.ts";
import {
  runNoDownstreamIncidentQuery,
  runNotReviewedQuery,
  runNotTouchingQuery,
} from "./negation-query.ts";

// -- seed helpers, copied from `ipc/diagnostics-rpc.test.ts:74-130` (Task 2 brief) --------------
// Production writers, not hand-rolled INSERTs: `recordPrChangedFiles` for PR coverage,
// `upsertGraphEntity`/`upsertGraphRelation` for the graph_entity bridge.

function seedCoveredPr(db: Database, id: string, paths: readonly string[]): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
  recordPrChangedFiles(db, {
    itemId: id,
    repoFull: "o/r",
    files: paths.map((path) => ({ path, status: "modified", counterpartPath: null })),
    apiFileCount: paths.length,
    truncated: false,
    nowMs: 1,
  });
}

function seedUncoveredPr(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'pr', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithoutIncident(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
}

function seedDeploymentNoGraphEntity(db: Database, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
}

function seedDeploymentWithIncident(db: Database, id: string): void {
  const depEntity = upsertGraphEntity(db, { type: "deployment", externalId: id, label: id });
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
     VALUES (?, 'github', 'deployment', ?, ?, 0, 0)`,
    [id, id, id],
  );
  const incidentEntity = upsertGraphEntity(db, {
    type: "incident",
    externalId: `inc-${id}`,
    label: `inc-${id}`,
  });
  upsertGraphRelation(db, depEntity, incidentEntity, "correlates_with", 0);
}

// `person` is a CO_OWNED_ENTITY_TYPE (`graph/relationship-graph.ts`), so `upsertGraphEntity`
// refuses it at compile time (`NonCoOwnedType`). Raw INSERT here, mirroring
// `index/negation-predicates.test.ts`'s and `ipc/people-rpc.test.ts`'s own person seed helpers.
function insertGraphEntity(db: Database, type: string, externalId: string, label: string): string {
  const id = `entity-${type}-${externalId}`;
  db.query(`INSERT INTO graph_entity (id, type, external_id, label) VALUES (?1, ?2, ?3, ?4)`).run(
    id,
    type,
    externalId,
    label,
  );
  return id;
}

function seedPersonWithReview(db: Database, id: string, createdAt: number): void {
  db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, [id]);
  const entity = insertGraphEntity(db, "person", id, id);
  const reviewedTarget = insertGraphEntity(db, "pr", `pr-${id}`, `pr-${id}`);
  upsertGraphRelation(db, entity, reviewedTarget, "reviewed", createdAt);
}

function seedPersonWithoutReview(db: Database, id: string): void {
  db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, [id]);
  insertGraphEntity(db, "person", id, id);
}

function freshIndex(): { index: LocalIndex; db: Database } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const index = new LocalIndex(db);
  return { index, db };
}

describe("runNotTouchingQuery", () => {
  test("refuses when no PR file coverage is indexed", () => {
    const { index, db } = freshIndex();
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("missing_substrate");
    expect(out.refusal.message).toContain("no PR file-coverage data is indexed");
    db.close();
  });

  test("returns rows plus per-reason gap counts when the substrate exists", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "touches-src", ["src/a.ts"]);
    seedCoveredPr(db, "touches-tests", ["tests/a.test.ts"]);
    seedUncoveredPr(db, "unfetched");
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.rows.map((r) => r.id)).toEqual(["touches-src"]);
    expect(out.gaps).toEqual({ excludedNoCoverage: 1, excludedTruncated: 0 });
    db.close();
  });

  test("explain carries the COMPOSED sql and the substrate probe, not the bare predicate", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 7, explain: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain?.sql).toContain("LIMIT ?");
    expect(out.explain?.substrate?.passed).toBe(true);
    db.close();
  });

  test("no explain requested means no explain block", () => {
    const { index, db } = freshIndex();
    seedCoveredPr(db, "p1", ["src/a.ts"]);
    const out = runNotTouchingQuery(db, index, { pathGlob: "tests/**", limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain).toBeUndefined();
    db.close();
  });
});

describe("runNoDownstreamIncidentQuery", () => {
  test("refuses when no correlates_with edges are indexed", () => {
    const { index, db } = freshIndex();
    const out = runNoDownstreamIncidentQuery(db, index, { limit: 20 });
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("missing_substrate");
    expect(out.refusal.message).toContain("no `correlates_with` edges are indexed");
    db.close();
  });

  test("returns rows plus the graph-entity gap count when the substrate exists", () => {
    const { index, db } = freshIndex();
    seedDeploymentWithIncident(db, "with-incident"); // non-empty substrate
    seedDeploymentWithoutIncident(db, "clean");
    seedDeploymentNoGraphEntity(db, "ungraphed");
    const out = runNoDownstreamIncidentQuery(db, index, { limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.rows.map((r) => r.id)).toEqual(["clean"]);
    expect(out.gaps).toEqual({ excludedNoGraphEntity: 1 });
    db.close();
  });

  test("explain carries the COMPOSED sql and the substrate probe, not the bare predicate", () => {
    const { index, db } = freshIndex();
    seedDeploymentWithIncident(db, "with-incident");
    seedDeploymentWithoutIncident(db, "clean");
    const out = runNoDownstreamIncidentQuery(db, index, { limit: 7, explain: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain?.sql).toContain("LIMIT ?");
    expect(out.explain?.substrate?.passed).toBe(true);
    db.close();
  });

  test("no explain requested means no explain block", () => {
    const { index, db } = freshIndex();
    seedDeploymentWithIncident(db, "with-incident");
    seedDeploymentWithoutIncident(db, "clean");
    const out = runNoDownstreamIncidentQuery(db, index, { limit: 20 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain).toBeUndefined();
    db.close();
  });
});

describe("runNotReviewedQuery", () => {
  test("refuses when no reviewed edges are indexed within the window", () => {
    const { db } = freshIndex();
    const out = runNotReviewedQuery(db, { limit: 20 });
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") return;
    expect(out.refusal.reason).toBe("missing_substrate");
    expect(out.refusal.message).toContain(
      "no `reviewed` edges are indexed within the --since window",
    );
    db.close();
  });

  test("returns rows plus the graph-entity gap count when the substrate exists", () => {
    const { db } = freshIndex();
    seedPersonWithReview(db, "eve", Date.now()); // non-empty substrate
    seedPersonWithoutReview(db, "bob");
    db.run(`INSERT INTO person (id, linked) VALUES (?, 1)`, ["carol"]); // no graph_entity row
    const out = runNotReviewedQuery(db, { limit: 20, sinceMs: 1 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.rows.map((r) => r.id)).toEqual(["bob"]);
    expect(out.gaps).toEqual({ excludedNoGraphEntity: 1 });
    db.close();
  });

  test("explain carries the COMPOSED sql and the substrate probe, not the bare predicate", () => {
    const { db } = freshIndex();
    seedPersonWithReview(db, "eve", Date.now());
    seedPersonWithoutReview(db, "bob");
    const out = runNotReviewedQuery(db, { limit: 7, sinceMs: 1, explain: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain?.sql).toContain("LIMIT ?");
    expect(out.explain?.substrate?.passed).toBe(true);
    db.close();
  });

  test("no explain requested means no explain block", () => {
    const { db } = freshIndex();
    seedPersonWithReview(db, "eve", Date.now());
    seedPersonWithoutReview(db, "bob");
    const out = runNotReviewedQuery(db, { limit: 20, sinceMs: 1 });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.explain).toBeUndefined();
    db.close();
  });
});
