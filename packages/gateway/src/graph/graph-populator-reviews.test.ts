import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { isItemLinkedGraphType } from "./relationship-graph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedPr(
  db: Database,
  externalId: string,
  title: string,
  authorId: string | null,
  at: number,
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId,
    title,
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    authorId,
    metadata: { repo: "acme/app", number: 1 },
  });
}

function seedReview(db: Database, externalId: string, reviewerId: string, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId,
    title: "Review on acme/app#1",
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    authorId: reviewerId,
    metadata: { repo: "acme/app", pr_number: 1 },
  });
}

/** Every (person external_id, pr external_id) pair joined by a `reviewed` edge. */
function reviewedPairs(db: Database): Array<{ person: string; pr: string }> {
  return db
    .query(
      `SELECT pe.external_id AS person, pre.external_id AS pr
         FROM graph_relation r
         JOIN graph_entity pe  ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity pre ON pre.id = r.to_id  AND pre.type = 'pr'
        WHERE r.type = 'reviewed'
        ORDER BY person, pr`,
    )
    .all() as Array<{ person: string; pr: string }>;
}

test("review is a graph-linked item type", () => {
  expect(isItemLinkedGraphType("review")).toBe(true);
});

test("a review item emits person -> pr reviewed", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);

  expect(reviewedPairs(db)).toEqual([{ person: "person-reviewer", pr: "github:acme/app#1" }]);
  db.close();
});

test("the reviewer is a distinct person from the PR author", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);

  const authored = db
    .query(
      `SELECT pe.external_id AS person
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
        WHERE r.type = 'authored'`,
    )
    .all() as Array<{ person: string }>;

  expect(authored).toEqual([{ person: "person-author" }]);
  expect(reviewedPairs(db)).toEqual([{ person: "person-reviewer", pr: "github:acme/app#1" }]);
  db.close();
});

// THE REGRESSION TEST. `syncPrGraph` calls `clearRelationsTouchingEntity`, which
// deletes every edge touching the PR except CROSS_ITEM_RELATION_TYPES. Without
// "reviewed" in that list, re-syncing the PR silently destroys the edge and
// nothing recreates it.
test("a reviewed edge survives the PR being re-populated", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);
  expect(reviewedPairs(db)).toHaveLength(1);

  // The PR is re-synced (title edit, state change, any later PullRequestEvent).
  seedPr(db, "acme/app#1", "Add rate limiter v2", "person-author", now + 1000);

  // PROVE THE RE-POPULATION ACTUALLY RAN. Without this the test is vacuous: if
  // `upsertIndexedItem` ever skipped graph population for an unchanged row, the
  // edge would "survive" because nothing touched it, and the assertion below
  // would stay green even with `reviewed` absent from CROSS_ITEM_RELATION_TYPES
  // — the precise defect this test exists to catch.
  const prLabel = db
    .query("SELECT label FROM graph_entity WHERE type = 'pr' AND external_id = ?")
    .get("github:acme/app#1") as { label: string };
  expect(prLabel.label).toBe("Add rate limiter v2");

  expect(reviewedPairs(db)).toEqual([{ person: "person-reviewer", pr: "github:acme/app#1" }]);
  db.close();
});

// The safety of having no edge-retirement mechanism (spec 5.F) rests on this.
test("two reviews by one person on one PR yield exactly one edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  seedReview(db, "acme/app#1#review-500", "person-reviewer", now);
  seedReview(db, "acme/app#1#review-501", "person-reviewer", now + 1);

  expect(reviewedPairs(db)).toHaveLength(1);
  db.close();
});

test("a review with no author emits no edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedPr(db, "acme/app#1", "Add rate limiter", "person-author", now);
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#1#review-500",
    title: "Review on acme/app#1",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: null,
    metadata: { repo: "acme/app", pr_number: 1 },
  });

  expect(reviewedPairs(db)).toEqual([]);
  db.close();
});

test("a review whose metadata lacks repo or pr_number emits no edge", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/app#1#review-500",
    title: "Review",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    authorId: "person-reviewer",
    metadata: {},
  });

  expect(reviewedPairs(db)).toEqual([]);
  db.close();
});
