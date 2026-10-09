import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { nonGithubMergedPrCount, selectMergedPrs } from "../../src/agents/changelog-queries.ts";
import { bitbucketPrMetadata } from "../../src/connectors/bitbucket-sync.ts";
import { createMemoryIndexDb } from "../../src/connectors/connector-sync-test-helpers.ts";
import { extractPrMetadataForIndex } from "../../src/connectors/github-sync.ts";
import {
  DEFAULT_DEPLOY_WORKFLOW_PATTERN,
  type ServiceConfig,
} from "../../src/metrics/dora-config.ts";

/**
 * Rows that SQLite accepts and JavaScript cannot read the same way.
 *
 * Every changelog query filters on `json_valid(i.metadata)` and windows on `json_extract`, then
 * re-parses the metadata in TypeScript. Two real divergences slip between those layers:
 *
 *  - a BLOB holding JSON text: SQLite treats it as JSON (`json_valid` = 1, `json_extract` works),
 *    but bun:sqlite hands JavaScript a `Uint8Array`, which `JSON.parse` rejects;
 *  - a DUPLICATE key: `json_extract` reads the FIRST occurrence, `JSON.parse` keeps the LAST, so
 *    a row can pass the SQL window on a number and reach TypeScript carrying a string.
 *
 * Either way the row must be dropped, never thrown on and never listed with a time it does not
 * have. (On a platform whose SQLite accepts JSON5 in `json_valid`, JSON5 metadata takes the same
 * fallback path as the BLOB here.)
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const WINDOW = { fromMs: NOW - 7 * DAY, toMs: NOW };

const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function freshDb(): Database {
  const db = createMemoryIndexDb();
  dbs.push(db);
  return db;
}

function serviceConfig(repos: ServiceConfig["repos"]): ServiceConfig {
  return {
    serviceId: "web",
    repos,
    pagerdutyServices: [],
    deployWorkflowPattern: new RegExp(DEFAULT_DEPLOY_WORKFLOW_PATTERN),
    incidentWindowMinutes: 60,
    excludePrLabels: [],
    deployEnvironments: ["prod"],
    severityP1Aliases: [],
  };
}

function insertPr(
  db: Database,
  row: { id: string; service: string; modifiedAt: number; metadata: string | Uint8Array },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at)
     VALUES (?, ?, 'pr', ?, ?, NULL, ?, ?, ?)`,
    [row.id, row.service, row.id, `PR ${row.id}`, row.modifiedAt, row.metadata, NOW],
  );
}

const asBlob = (json: string): Uint8Array => new TextEncoder().encode(json);

describe("selectMergedPrs — metadata SQLite accepts but JavaScript cannot read", () => {
  function seedMerged(db: Database): void {
    const merged = JSON.stringify(
      extractPrMetadataForIndex(
        "org/web",
        { number: 1, state: "closed", merged: true, merged_at: new Date(NOW - DAY).toISOString() },
        NOW,
      ),
    );
    insertPr(db, { id: "github:text", service: "github", modifiedAt: NOW - DAY, metadata: merged });
    insertPr(db, {
      id: "github:blob",
      service: "github",
      modifiedAt: NOW - DAY,
      metadata: asBlob(merged),
    });
    insertPr(db, {
      id: "github:dup",
      service: "github",
      modifiedAt: NOW - DAY,
      // Deliberately a shape no writer produces: the real merged row plus a DUPLICATE `merged_at`
      // key, which `json_extract` reads first (the number) and `JSON.parse` reads last (a string).
      metadata: `${merged.slice(0, -1)},"merged_at":"yesterday"}`,
    });
  }

  test("unscoped: the BLOB row and the duplicate-key row are dropped, the readable one listed", () => {
    const db = freshDb();
    seedMerged(db);
    // Both odd rows really do pass the SQL layer — the drop happens in TypeScript.
    const sqlSeen = db
      .query(
        `SELECT COUNT(*) AS n FROM item WHERE type = 'pr' AND json_valid(metadata)
           AND json_extract(metadata, '$.merged_at') >= ? AND json_extract(metadata, '$.merged_at') < ?`,
      )
      .get(WINDOW.fromMs, WINDOW.toMs) as { n: number };
    expect(sqlSeen.n).toBe(3);

    const rows = selectMergedPrs(db, { ...WINDOW, scope: { kind: "all" } });
    expect(rows.map((r) => r.id)).toEqual(["github:text"]);
    expect(rows[0]).toMatchObject({ atMs: NOW - DAY, timeSource: "event" });
  });

  test("service-scoped: the repo filter tolerates the unreadable BLOB metadata", () => {
    const db = freshDb();
    seedMerged(db);
    const cfg = serviceConfig([{ provider: "github", providerId: "org/web" }]);
    const rows = selectMergedPrs(db, { ...WINDOW, scope: { kind: "service", cfg } });
    expect(rows.map((r) => r.id)).toEqual(["github:text"]);
  });
});

describe("nonGithubMergedPrCount — scoped count over unreadable metadata", () => {
  test("the SQL-level count includes a BLOB row; the repo-scoped count cannot attribute it", () => {
    const db = freshDb();
    // Bitbucket is the writer that really produces a merged row with no `merged_at`.
    const meta = JSON.stringify(
      bitbucketPrMetadata(
        "group/proj",
        { id: 3, state: "MERGED", created_on: new Date(NOW - 9 * DAY).toISOString() },
        "Dana",
      ),
    );
    insertPr(db, {
      id: "bitbucket:text",
      service: "bitbucket",
      modifiedAt: NOW - DAY,
      metadata: meta,
    });
    insertPr(db, {
      id: "bitbucket:blob",
      service: "bitbucket",
      modifiedAt: NOW - DAY,
      metadata: asBlob(meta),
    });

    expect(nonGithubMergedPrCount(db, { ...WINDOW, scope: { kind: "all" } })).toBe(2);
    const cfg = serviceConfig([{ provider: "bitbucket", providerId: "group/proj" }]);
    expect(nonGithubMergedPrCount(db, { ...WINDOW, scope: { kind: "service", cfg } })).toBe(1);
  });
});
