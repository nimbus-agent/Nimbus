import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

function mentionTargets(db: Database): string[] {
  const rows = db
    .query(
      `SELECT e.type || ':' || e.external_id AS ref
         FROM graph_relation r
         JOIN graph_entity e ON e.id = r.to_id
        WHERE r.type = 'mentions'
        ORDER BY ref`,
    )
    .all() as Array<{ ref: string }>;
  return rows.map((r) => r.ref);
}

function seedMessage(db: Database, body: string, at: number): void {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C1/1000.1",
    title: body,
    bodyPreview: body,
    modifiedAt: at,
    syncedAt: at,
    metadata: { channel: "C1" },
  });
}

test("a message naming a ticket key mentions that issue", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);

  expect(mentionTargets(db)).toEqual(["issue:linear:NIM-88"]);
});

test("a message naming a commit SHA mentions that commit", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: "a1b2c3d4e5f6",
    title: "Fix retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha: "a1b2c3d4e5f6", repoRoot: "/repo" },
  });

  seedMessage(db, "this broke in a1b2c3d4e5f6", now);

  expect(mentionTargets(db)).toEqual(["commit:github:a1b2c3d4e5f6"]);
});

test("a message referencing nothing indexed emits no edges", () => {
  const db = freshDb();
  const now = Date.now();
  seedMessage(db, "lunch?", now);
  expect(mentionTargets(db)).toEqual([]);
});

test("editing a message to drop the reference drops the edge", () => {
  const db = freshDb();
  const now = Date.now();
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });

  seedMessage(db, "anyone looking at NIM-88?", now);
  seedMessage(db, "never mind", now + 1);

  expect(mentionTargets(db)).toEqual([]);
});

test("a message citing a short SHA prefix mentions the full-length indexed commit", () => {
  const db = freshDb();
  const now = Date.now();
  const fullSha = "a1b2c3d4e5f60123456789abcdef0123456789ab";
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: fullSha,
    title: "Fix retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha: fullSha, repoRoot: "/repo" },
  });

  // 7-character short SHA — the dominant real-world citation form, and
  // exactly the case `COMMIT_SHA_RE`'s `{7,40}` lower bound exists to catch.
  // Against the old exact-suffix `LIKE '%:' || ?` SQL this matches nothing.
  seedMessage(db, "this broke in a1b2c3d", now);

  expect(mentionTargets(db)).toEqual([`commit:github:${fullSha}`]);
});

test("a message citing both an issue and a commit mentions both", () => {
  const db = freshDb();
  const now = Date.now();
  const fullSha = "a1b2c3d4e5f60123456789abcdef0123456789ab";
  upsertIndexedItem(db, {
    service: "linear",
    type: "issue",
    externalId: "NIM-88",
    title: "Retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: {},
  });
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: fullSha,
    title: "Fix retry backoff",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha: fullSha, repoRoot: "/repo" },
  });

  seedMessage(db, "NIM-88 was fixed by a1b2c3d", now);

  expect(mentionTargets(db)).toEqual([`commit:github:${fullSha}`, "issue:linear:NIM-88"]);
});

test("a SHA colliding across two services resolves to exactly one commit", () => {
  const db = freshDb();
  const now = Date.now();
  const sha = "a1b2c3d4e5f60123456789abcdef0123456789ab";
  upsertIndexedItem(db, {
    service: "github",
    type: "git_commit",
    externalId: sha,
    title: "Fix retry backoff (github)",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha, repoRoot: "/repo" },
  });
  upsertIndexedItem(db, {
    service: "gitlab",
    type: "git_commit",
    externalId: sha,
    title: "Fix retry backoff (gitlab)",
    bodyPreview: "",
    modifiedAt: now,
    syncedAt: now,
    metadata: { sha, repoRoot: "/repo" },
  });

  seedMessage(db, `this broke in ${sha}`, now);

  const targets = mentionTargets(db);
  expect(targets).toHaveLength(1);
  expect(targets[0]).toMatch(new RegExp(`^commit:(github|gitlab):${sha}$`));
});
