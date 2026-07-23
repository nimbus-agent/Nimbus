import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import { type RegraphResult, regraphAllItems } from "./regraph.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** Insert an item directly, bypassing the populator, to simulate pre-existing data. */
function insertRawItem(
  db: Database,
  o: { service: string; type: string; externalId: string; title: string; body: string; at: number },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      `${o.service}:${o.externalId}`,
      o.service,
      o.type,
      o.externalId,
      o.title,
      o.body,
      o.at,
      o.at,
      JSON.stringify({ repo: "acme/app" }),
    ],
  );
}

test("backfill graphs items that were indexed before the populator knew how", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  expect((db.query("SELECT COUNT(*) AS n FROM graph_relation").get() as { n: number }).n).toBe(0);

  const result = regraphAllItems(db);

  expect(result.scanned).toBe(2);
  expect(result.graphed).toBe(2);
  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test("backfill skips item types the graph does not participate in", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "gdrive",
    type: "file",
    externalId: "f1",
    title: "Notes",
    body: "",
    at: now,
  });

  const result = regraphAllItems(db);
  expect(result.scanned).toBe(1);
  expect(result.graphed).toBe(0);
});

test("backfill is idempotent", () => {
  const db = freshDb();
  const now = Date.now();
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });

  regraphAllItems(db);
  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

test("one pass settles a forward reference that sorts the wrong way by id", () => {
  const db = freshDb();
  const now = Date.now();

  // `github:acme/app#1` (the PR) sorts BEFORE `github:acme/app#4` (the issue),
  // so an id-ordered backfill processes the PR while the issue entity does not
  // yet exist and emits nothing. Type ordering is what makes one pass enough.
  insertRawItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/app#1",
    title: "Fix login",
    body: "closes #4",
    at: now,
  });
  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });

  regraphAllItems(db);

  expect(
    (
      db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
        n: number;
      }
    ).n,
  ).toBe(1);
});

/**
 * 5 issues + 5 PRs, each PR resolving the issue with the matching number.
 * Both groups land in their own `REGRAPH_TYPE_ORDER` slice (issue, then pr),
 * and each slice has >= 5 rows so a `batchSize: 1` run pages 5 times per
 * slice instead of settling in one page.
 */
function insertIssuePrFixture(db: Database, now: number): void {
  for (let n = 1; n <= 5; n++) {
    insertRawItem(db, {
      service: "github",
      type: "issue",
      externalId: `acme/app#${n}`,
      title: `Issue ${n}`,
      body: "",
      at: now,
    });
  }
  for (let n = 1; n <= 5; n++) {
    insertRawItem(db, {
      service: "github",
      type: "pr",
      externalId: `acme/app#${100 + n}`,
      title: `Fix ${n}`,
      body: `closes #${n}`,
      at: now,
    });
  }
}

test("keyset pagination scans and graphs every row exactly once across multiple pages", () => {
  const db = freshDb();
  const now = Date.now();
  insertIssuePrFixture(db, now);

  const paged = regraphAllItems(db, { batchSize: 1 });

  // 5 issues + 5 PRs. A skipped row would undercount; a repeated row (e.g. a
  // cursor using `id >= lastId` re-fetching the same row) would overcount.
  expect(paged.scanned).toBe(10);
  expect(paged.graphed).toBe(10);

  const pagedResolves = (
    db.query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'").get() as {
      n: number;
    }
  ).n;
  // Real resolves edges, not just row counts: each of the 5 PRs resolves its
  // matching issue, and a skipped issue row would leave its PR's edge unresolved.
  expect(pagedResolves).toBe(5);

  // The same fixture run single-page (default batchSize, well above 10 rows)
  // in a fresh DB must produce an identical graph — pagination must not
  // change the outcome, only how many round trips it takes to get there.
  const singlePageDb = freshDb();
  insertIssuePrFixture(singlePageDb, now);
  const singlePage = regraphAllItems(singlePageDb);

  expect(singlePage.scanned).toBe(paged.scanned);
  expect(singlePage.graphed).toBe(paged.graphed);
  expect(
    (
      singlePageDb
        .query("SELECT COUNT(*) AS n FROM graph_relation WHERE type = 'resolves'")
        .get() as {
        n: number;
      }
    ).n,
  ).toBe(pagedResolves);
});

test("a corrupt metadata JSON row degrades to {} instead of aborting the backfill", () => {
  const db = freshDb();
  const now = Date.now();

  // Malformed metadata, inserted directly with db.run: insertRawItem always
  // JSON.stringifies, so it can never produce invalid JSON.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      "github:acme/app#corrupt",
      "github",
      "issue",
      "acme/app#corrupt",
      "Corrupt metadata issue",
      "",
      now,
      now,
      "{not json",
    ],
  );

  // NULL metadata: same fallback path (`parseMetadata`'s early return), no
  // JSON.parse attempted at all.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      "github:acme/app#nullmeta",
      "github",
      "issue",
      "acme/app#nullmeta",
      "Null metadata issue",
      "",
      now,
      now,
      null,
    ],
  );

  // Empty-string metadata: the other explicit early-return branch.
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      "github:acme/app#emptymeta",
      "github",
      "issue",
      "acme/app#emptymeta",
      "Empty metadata issue",
      "",
      now,
      now,
      "",
    ],
  );

  insertRawItem(db, {
    service: "github",
    type: "issue",
    externalId: "acme/app#4",
    title: "Login broken",
    body: "",
    at: now,
  });

  let result: RegraphResult | undefined;
  expect(() => {
    result = regraphAllItems(db);
  }).not.toThrow();

  expect(result?.scanned).toBe(4);
  // All four rows are the graph-participating `issue` type: the metadata
  // fallback only affects what fields the sync reads, never whether the row
  // is graphed at all.
  expect(result?.graphed).toBe(4);

  // The valid item — indexed alongside three corrupt/null/empty metadata
  // siblings — still got graphed; the corrupt rows did not abort the pass.
  const validItemGraphed = (
    db
      .query("SELECT COUNT(*) AS n FROM graph_entity WHERE type = 'issue' AND external_id = ?")
      .get("github:acme/app#4") as { n: number }
  ).n;
  expect(validItemGraphed).toBe(1);
});
