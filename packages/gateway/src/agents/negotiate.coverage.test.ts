/**
 * negotiate.coverage.test.ts — the arms of agents/negotiate.ts the main suite leaves open: an
 * unreadable graph (lanes fail BY NAME and no split-identity disclosure is invented on top), a
 * split-identity twin with no display name, and authored-PR metadata that is unparseable, not an
 * object, or carries only some of the size fields.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";

import { dbExec, dbRun } from "../db/write.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runNegotiate } from "./negotiate.ts";

const DAY = 86_400_000;

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return db;
}

function ctxFor(db: Database) {
  return { db, notify: () => {}, sessionId: "negotiate-cov", personalSources: [] };
}

function seedPerson(
  db: Database,
  p: { id: string; displayName: string | null; email?: string; githubLogin?: string },
): void {
  dbRun(
    db,
    "INSERT INTO person (id, display_name, canonical_email, github_login) VALUES (?, ?, ?, ?)",
    [p.id, p.displayName, p.email ?? null, p.githubLogin ?? null],
  );
}

function seedPr(
  db: Database,
  num: number,
  authorId: string,
  meta: Record<string, unknown>,
): string {
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: `acme/app#${String(num)}`,
    title: `PR ${String(num)}`,
    bodyPreview: "",
    modifiedAt: Date.now(),
    syncedAt: Date.now(),
    authorId,
    metadata: { repo: "acme/app", number: num, ...meta },
  });
  return `github:acme/app#${String(num)}`;
}

test("an unreadable graph fails the lanes by name and invents no split-identity note", async () => {
  const db = freshDb();
  seedPerson(db, { id: "person:me", displayName: "Me", email: "me@example.com" });
  seedPr(db, 1, "person:me", { merged: true });
  // The graph is gone: every lane that walks it rejects. The zero-edge probe must then report
  // NOTHING — "the graph is unreadable" is not "this person has no edges".
  dbExec(db, "DROP TABLE graph_relation");

  const brief = await runNegotiate(
    { sinceMs: 30 * DAY, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  expect(brief.authoredPrs).toBeNull();
  const laneFailure = brief.gaps.find((g) => g.detail.startsWith("negotiate lane `authoredPrs`"));
  expect(laneFailure?.category).toBe("missing_connector");
  expect(laneFailure?.detail).toMatch(/^negotiate lane `authoredPrs` failed: .+/);
  expect(brief.gaps.some((g) => g.detail.includes("is an indexed person but has no"))).toBe(false);
});

test("a split-identity twin with no display name is named by its id", async () => {
  const db = freshDb();
  // The subject holds no edges; a second, unlinked row shares the handle `asaf` (the email's
  // local part on one, the GitHub login on the other) and holds the authored PR.
  seedPerson(db, { id: "person:me", displayName: "Me", email: "asaf@example.com" });
  seedPerson(db, { id: "person:gh-asaf", displayName: null, githubLogin: "asaf" });
  seedPr(db, 2, "person:gh-asaf", { merged: true });

  const brief = await runNegotiate(
    { sinceMs: 30 * DAY, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("is an indexed person but has no"));
  expect(gap?.category).toBe("missing_user_identity");
  expect(gap?.detail).toContain("Another indexed record — person:gh-asaf — shares an identity");
  expect(gap?.detail).not.toContain("null (person:gh-asaf)");
  expect(gap?.remediation).toBe(
    "Merge them with `nimbus people link person:me person:gh-asaf`, then re-run this brief.",
  );
});

test("a lookalike scan that cannot run still fires the structural-zero note, naming no record", async () => {
  const db = freshDb();
  seedPerson(db, { id: "person:me", displayName: "Me", email: "asaf@example.com" });
  seedPerson(db, { id: "person:gh-asaf", displayName: "Asaf", githubLogin: "asaf" });
  seedPr(db, 4, "person:gh-asaf", { merged: true });
  // The edge count still reads (graph tables are intact), but the handle scan selects a column
  // this schema no longer has. Failing to FIND a twin must not suppress the note itself.
  // RENAME, not DROP: SQLite refuses to drop a column an index or trigger names, so a future
  // migration indexing `slack_handle` would fail this setup line rather than the code under test.
  dbExec(db, "ALTER TABLE person RENAME COLUMN slack_handle TO slack_handle_renamed");

  const brief = await runNegotiate(
    { sinceMs: 30 * DAY, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  const gap = brief.gaps.find((g) => g.detail.includes("is an indexed person but has no"));
  expect(gap?.category).toBe("missing_user_identity");
  expect(gap?.detail).not.toContain("Another indexed record");
  expect(gap?.remediation).toContain("Run `nimbus people search <name>`");
});

test("unparseable and non-object PR metadata stay in the count but out of merged and stats", async () => {
  const db = freshDb();
  seedPerson(db, { id: "person:me", displayName: "Me", email: "me@example.com" });
  // Size fields only partly recorded: additions without deletions or changed_files.
  seedPr(db, 1, "person:me", { merged: true, additions: 10 });
  const corrupt = seedPr(db, 2, "person:me", { merged: true, additions: 500 });
  const notAnObject = seedPr(db, 3, "person:me", { merged: true, additions: 700 });
  // JSON `null` parses fine but is no object: read as-is, `meta["merged"]` would THROW and fail the
  // whole lane, which is why the parser maps it to `{}`. (An array needs no such guard — indexing
  // one by a string key just yields `undefined` — so `[1, 2]` alone cannot pin it.)
  const jsonNull = seedPr(db, 5, "person:me", { merged: true, additions: 900 });
  dbRun(db, "UPDATE item SET metadata = ? WHERE id = ?", ["{not json", corrupt]);
  dbRun(db, "UPDATE item SET metadata = ? WHERE id = ?", ["[1, 2]", notAnObject]);
  dbRun(db, "UPDATE item SET metadata = ? WHERE id = ?", ["null", jsonNull]);

  const brief = await runNegotiate(
    { sinceMs: 30 * DAY, mePersonIdOverride: "person:me" },
    ctxFor(db),
  );

  expect(brief.authoredPrs?.count).toBe(4);
  expect(brief.authoredPrs?.merged).toBe(1);
  expect(brief.authoredPrs?.statsCoverage).toEqual({ covered: 1, total: 4 });
  expect(brief.authoredPrs?.stats).toEqual({ additions: 10, deletions: 0, changedFiles: 0 });
});
