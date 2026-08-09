import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { affectedServicesForEpic } from "./epic-services.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

function addItem(db: Database, id: string, externalId: string, metadata: object): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, 'jira', 'issue', ?, 'T', ?, 1, 1, 0)`,
    [id, externalId, JSON.stringify(metadata)],
  );
}

/**
 * Real `graph_entity` columns (graph-v7-sql.ts): id, type, external_id, label,
 * service, metadata — there is NO `kind` column and `external_id` is NOT NULL.
 * A PR entity carries its repo as `metadata.repo`, which is the hop this
 * traversal reads.
 */
function addEntity(db: Database, id: string, type: string, repo?: string): void {
  db.run(
    `INSERT OR IGNORE INTO graph_entity (id, type, external_id, label, service, metadata)
     VALUES (?, ?, ?, ?, 'github', ?)`,
    [id, type, id, id, repo === undefined ? null : JSON.stringify({ repo })],
  );
}

/** Real `graph_relation` columns: from_id, to_id, type, weight, metadata, created_at. */
function addRelation(db: Database, from: string, to: string, type: string): void {
  db.run(
    `INSERT OR IGNORE INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, ?, 1)`,
    [from, to, type],
  );
}

test("derives services through children -> resolving PRs -> the PR's repo", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, "github:pr:7", "jira:PROJ-2", "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("merges and sorts services across several children", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  for (const [child, pr, repo] of [
    ["jira:PROJ-2", "github:pr:7", "acme/billing-api"],
    ["jira:PROJ-3", "github:pr:8", "acme/payments-worker"],
    ["jira:PROJ-4", "github:pr:9", "acme/billing-api"],
  ] as const) {
    addItem(db, child, child.split(":")[1] ?? child, { meta_v: 1, parent_key: "PROJ-1" });
    addEntity(db, child, "issue");
    addEntity(db, pr, "pr", repo);
    addRelation(db, pr, child, "resolves");
  }
  // Sorted and de-duplicated: the caller compares these sets, so a stable
  // order keeps cohort ranking deterministic across runs.
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([
    "acme/billing-api",
    "acme/payments-worker",
  ]);
  db.close();
});

test("a PR with no repo in its metadata contributes nothing, not a null service", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  addEntity(db, "github:pr:7", "pr"); // no repo
  addRelation(db, "github:pr:7", "jira:PROJ-2", "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("an epic with no children resolves to no services", () => {
  // The brand-new-epic case. PR B turns this into a named gap and the
  // `--service` prompt; it must never look like an answer.
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("children whose PRs never referenced them resolve to no services", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  addEntity(db, "jira:PROJ-2", "issue");
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("a child of a DIFFERENT epic is not counted", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:OTHER-9", "OTHER-9", { meta_v: 1, parent_key: "OTHER-1" });
  addEntity(db, "jira:OTHER-9", "issue");
  addEntity(db, "github:pr:7", "pr", "acme/search");
  addRelation(db, "github:pr:7", "jira:OTHER-9", "resolves");
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});
