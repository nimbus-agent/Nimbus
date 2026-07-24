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

// Fixtures below are built with the exact expressions github-sync.ts uses
// to index PRs and issues (`${repoFull}#${num}` / `${repoFull}#issue-${num}`,
// plus the same `number`/`repo` metadata keys), NOT hand-picked shapes — see
// `upsertPr`/`upsertFromIssue` in connectors/github-sync.ts.
function seedGithubIssue(
  db: Database,
  repoFull: string,
  num: number,
  title: string,
  at: number,
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: `${repoFull}#issue-${String(num)}`,
    title,
    bodyPreview: "",
    modifiedAt: at,
    syncedAt: at,
    metadata: { number: num, repo: repoFull, state: "open", user: "octocat" },
  });
}

function seedGithubPr(
  db: Database,
  repoFull: string,
  num: number,
  title: string,
  bodyPreview: string,
  at: number,
): void {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `${repoFull}#${String(num)}`,
    title,
    bodyPreview,
    modifiedAt: at,
    syncedAt: at,
    metadata: { number: num, repo: repoFull, state: "open", draft: false, merged: false },
  });
}

test("a GitHub PR body referencing #4, with the issue indexed under github-sync.ts's real externalId shape, emits a resolves edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedGithubIssue(db, "acme/app", 4, "Login broken", now);
  seedGithubPr(db, "acme/app", 1, "Fix login", "closes #4", now);

  expect(resolvesTargets(db)).toEqual(["github:acme/app#issue-4"]);
});

test("I-3: a GitHub closes #4 resolves via the indexed external_id path, not the metadata scan", () => {
  const db = freshDb();
  const now = Date.now();
  // The issue is indexed under github-sync.ts's real externalId shape
  // (`${repo}#issue-${n}`), but its OWN metadata.number is deliberately
  // wrong (999, not 4). A metadata-scan-first lookup (`number=4 AND repo=...`)
  // would never match this row — proving the resolution came from the fast,
  // indexed external_id lookup (I-3's fix), not the metadata fallback.
  upsertIndexedItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#issue-4",
    title: "Login broken",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { number: 999, repo: "acme/app", state: "open", user: "octocat" },
  });
  seedGithubPr(db, "acme/app", 4, "Fix login", "closes #4", now);

  expect(resolvesTargets(db)).toEqual(["github:acme/app#issue-4"]);
});

test("a GitHub PR body referencing #4 with no matching issue (real externalId shape) emits no edge", () => {
  const db = freshDb();
  const now = Date.now();
  seedGithubPr(db, "acme/app", 1, "Fix login", "closes #4", now);

  expect(resolvesTargets(db)).toEqual([]);
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
