import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function seedIssue(db: Database, externalId: string, title: string, at: number): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId,
    title,
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { repo: "acme/app" },
  });
}

function resolvesTargets(db: Database): string[] {
  const rows = db
    .query(
      `SELECT e.external_id AS ext
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = 'resolves'
        ORDER BY ext`,
    )
    .all() as Array<{ ext: string }>;
  return rows.map((r) => r.ext);
}

test("a PR body referencing #4 emits resolves to that repo's issue 4", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #4",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["github:acme/app#4"]);
});

test("a numeric ref with no matching issue emits no edge", () => {
  const db = freshDb();
  const now = Date.now();

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #999",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual([]);
});

test("a ticket key matches an issue indexed by another service", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff is wrong",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix retry backoff",
    bodyPreview: "part of NIM-88",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["linear:NIM-88"]);
});

test("a numeric ref is scoped to the referring PR's own repo — same key in another repo is excluded", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: "other/app#4",
    title: "Unrelated issue in a different repo",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "other/app" },
  });

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #4",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["github:acme/app#4"]);
});

test("an incoming resolves edge survives the target issue's own re-sync", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);

  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    bodyPreview: "closes #4",
    modifiedAt: now,
    syncedAt: now,
    metadata: { repo: "acme/app" },
  });

  expect(resolvesTargets(db)).toEqual(["github:acme/app#4"]);

  // Re-sync the ISSUE itself (not the PR) — this runs syncIssueGraph, which
  // calls clearRelationsTouchingEntity on the issue entity. The incoming
  // `resolves` edge from the PR must not be swept up in that blanket clear.
  seedIssue(db, "acme/app#4", "Login broken — retitled", now + 1);

  expect(resolvesTargets(db)).toEqual(["github:acme/app#4"]);
});

test("removing the reference from the PR body removes the edge on re-sync", () => {
  const db = freshDb();
  const now = Date.now();
  seedIssue(db, "acme/app#4", "Login broken", now);

  for (const [i, body] of ["closes #4", "no longer references anything"].entries()) {
    upsertIndexedItem(db, {
      service: "github",
      type: "pr",
      externalId: "acme/app#1",
      title: "Fix login",
      bodyPreview: body,
      modifiedAt: now + i,
      syncedAt: now + i,
      metadata: { repo: "acme/app" },
    });
  }

  expect(resolvesTargets(db)).toEqual([]);
});
