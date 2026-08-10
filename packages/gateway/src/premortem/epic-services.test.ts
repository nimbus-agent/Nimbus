import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { upsertGraphEntity } from "../graph/relationship-graph.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { affectedServicesForEpic, affectedServicesForEpics } from "./epic-services.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 53);
  return db;
}

function addItem(
  db: Database,
  id: string,
  externalId: string,
  metadata: object,
  service = "jira",
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, ?, 'issue', ?, 'T', ?, 1, 1, 0)`,
    [id, service, externalId, JSON.stringify(metadata)],
  );
}

/**
 * Mints a `graph_entity` row through the REAL production write path
 * (`upsertGraphEntity`), so `graph_entity.id` is the same deterministic
 * `sha256(type + "\0" + externalId)` hash production writes — never the raw
 * item id. A hand-rolled `INSERT` that set `graph_entity.id` to the
 * caller-supplied id previously made `graph_entity.id == item.id` true only
 * in the fixture, hiding a query that could never match in production.
 *
 * `externalId` is the item id for `issue`/`pr` entities (mirrors
 * `graph-populator.ts`'s `syncIssueGraph`/`syncPrGraph`, both of which pass
 * `externalId: row.id`).
 */
function addEntity(db: Database, externalId: string, type: string, repo?: string): string {
  return upsertGraphEntity(db, {
    type,
    externalId,
    label: externalId,
    service: "github",
    metadata: repo === undefined ? null : { repo },
  });
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
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt, issueEnt, "resolves");

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
    const issueEnt = addEntity(db, child, "issue");
    const prEnt = addEntity(db, pr, "pr", repo);
    addRelation(db, prEnt, issueEnt, "resolves");
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
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr"); // no repo
  addRelation(db, prEnt, issueEnt, "resolves");

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
  const issueEnt = addEntity(db, "jira:OTHER-9", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/search");
  addRelation(db, prEnt, issueEnt, "resolves");
  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual([]);
  db.close();
});

test("a same-key child in a DIFFERENT service is not counted (service scoping)", () => {
  // Two trackers can collide on a bare key like `PROJ-1`. Only the epic's own
  // `item.service` may contribute — `child.id <> ?` alone does not prevent
  // this, since it only excludes one exact row, not a whole other tracker.
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" }, "jira");
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" }, "jira");
  const jiraIssueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const jiraPrEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, jiraPrEnt, jiraIssueEnt, "resolves");

  // A different tracker's item happens to carry the SAME parent_key value.
  addItem(db, "linear:LIN-9", "LIN-9", { meta_v: 1, parent_key: "PROJ-1" }, "linear");
  const linearIssueEnt = addEntity(db, "linear:LIN-9", "issue");
  const linearPrEnt = addEntity(db, "github:pr:99", "pr", "acme/unrelated-service");
  addRelation(db, linearPrEnt, linearIssueEnt, "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("FINDING 3 — the batch form (affectedServicesForEpics) resolves several epics in ONE call, agreeing with the single-epic form", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt1 = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt1 = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt1, issueEnt1, "resolves");

  addItem(db, "jira:PROJ-10", "PROJ-10", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-11", "PROJ-11", { meta_v: 1, parent_key: "PROJ-10" });
  const issueEnt2 = addEntity(db, "jira:PROJ-11", "issue");
  const prEnt2 = addEntity(db, "github:pr:8", "pr", "acme/search");
  addRelation(db, prEnt2, issueEnt2, "resolves");

  // A third epic with no children at all — must resolve to "not in the map"
  // (never a spurious empty-array entry that shadows a real miss).
  addItem(db, "jira:PROJ-20", "PROJ-20", { meta_v: 1, issue_type: "Epic" });

  const result = affectedServicesForEpics(db, ["jira:PROJ-1", "jira:PROJ-10", "jira:PROJ-20"]);
  expect(result.get("jira:PROJ-1")).toEqual(["acme/billing-api"]);
  expect(result.get("jira:PROJ-10")).toEqual(["acme/search"]);
  expect(result.has("jira:PROJ-20")).toBe(false);
  db.close();
});

test("affectedServicesForEpics: an empty input never queries and returns an empty map", () => {
  const db = freshDb();
  expect(affectedServicesForEpics(db, [])).toEqual(new Map());
  db.close();
});

test("affectedServicesForEpics: honors service scoping the same way the single-epic form does", () => {
  // Mirrors the test above, but through the batch entry point.
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" }, "jira");
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" }, "jira");
  const jiraIssueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const jiraPrEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, jiraPrEnt, jiraIssueEnt, "resolves");

  addItem(db, "linear:LIN-9", "LIN-9", { meta_v: 1, parent_key: "PROJ-1" }, "linear");
  const linearIssueEnt = addEntity(db, "linear:LIN-9", "issue");
  const linearPrEnt = addEntity(db, "github:pr:99", "pr", "acme/unrelated-service");
  addRelation(db, linearPrEnt, linearIssueEnt, "resolves");

  const result = affectedServicesForEpics(db, ["jira:PROJ-1"]);
  expect(result.get("jira:PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("a same-service, non-JSON metadata row elsewhere in item does not break affectedServicesForEpic (child-side json_valid guard)", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt, issueEnt, "resolves");

  // The bad row must be WIRED INTO THE GRAPH (its own issue entity + a
  // resolving PR) so it actually survives this query's INNER JOINs into
  // `graph_entity`/`graph_relation` and reaches the WHERE clause's
  // `json_extract(child.metadata, ...)`. An `item` row with no matching
  // `graph_entity` never gets that far in THIS query shape (the child-side
  // json_extract lives in the WHERE, not the JOIN, unlike the batch form
  // below) -- it is eliminated by the join itself before its metadata is
  // ever read, so an unwired row could never prove this guard does
  // anything.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, ?, 'issue', ?, 'T', ?, 1, 1, 0)`,
    ["jira:BAD-1", "jira", "BAD-1", "not json"],
  );
  const badIssueEnt = addEntity(db, "jira:BAD-1", "issue");
  const badPrEnt = addEntity(db, "github:pr:bad", "pr", "acme/bad-service");
  addRelation(db, badPrEnt, badIssueEnt, "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("a same-service, non-JSON metadata row elsewhere in item does not break affectedServicesForEpics (child-side json_valid guard, batch form)", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });
  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt, issueEnt, "resolves");

  db.run(
    `INSERT INTO item (id, service, type, external_id, title, metadata, modified_at, synced_at, pinned)
     VALUES (?, ?, 'issue', ?, 'T', ?, 1, 1, 0)`,
    ["jira:BAD-1", "jira", "BAD-1", "not json"],
  );

  const result = affectedServicesForEpics(db, ["jira:PROJ-1"]);
  expect(result.get("jira:PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("a PR entity with non-JSON metadata does not break affectedServicesForEpic (pr-side json_valid guard)", () => {
  // `upsertGraphEntity` always JSON.stringifies (or writes NULL), so this
  // never happens through the real write path -- it simulates corrupted
  // data, defensively guarded the same way the child-side hop is.
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });

  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt, issueEnt, "resolves");

  addItem(db, "jira:PROJ-3", "PROJ-3", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt2 = addEntity(db, "jira:PROJ-3", "issue");
  const badPrId = "bad-pr-entity-id";
  db.run(
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'pr', ?, ?, ?, ?)`,
    [badPrId, "github:pr:8", "github:pr:8", "github", "not json"],
  );
  addRelation(db, badPrId, issueEnt2, "resolves");

  expect(affectedServicesForEpic(db, "jira:PROJ-1", "PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});

test("a PR entity with non-JSON metadata does not break affectedServicesForEpics (pr-side json_valid guard, batch form)", () => {
  const db = freshDb();
  addItem(db, "jira:PROJ-1", "PROJ-1", { meta_v: 1, issue_type: "Epic" });

  addItem(db, "jira:PROJ-2", "PROJ-2", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt = addEntity(db, "jira:PROJ-2", "issue");
  const prEnt = addEntity(db, "github:pr:7", "pr", "acme/billing-api");
  addRelation(db, prEnt, issueEnt, "resolves");

  addItem(db, "jira:PROJ-3", "PROJ-3", { meta_v: 1, parent_key: "PROJ-1" });
  const issueEnt2 = addEntity(db, "jira:PROJ-3", "issue");
  const badPrId = "bad-pr-entity-id-batch";
  db.run(
    `INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'pr', ?, ?, ?, ?)`,
    [badPrId, "github:pr:8b", "github:pr:8b", "github", "not json"],
  );
  addRelation(db, badPrId, issueEnt2, "resolves");

  const result = affectedServicesForEpics(db, ["jira:PROJ-1"]);
  expect(result.get("jira:PROJ-1")).toEqual(["acme/billing-api"]);
  db.close();
});
