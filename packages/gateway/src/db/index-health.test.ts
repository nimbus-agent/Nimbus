import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  COVERAGE_WEIGHT,
  collectIndexHealth,
  DEFAULT_STALE_THRESHOLD_DAYS,
  FRESHNESS_WEIGHT,
} from "./index-health.ts";

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const DAY_MS = 86_400_000;

/**
 * The columns `collectIndexHealth` reads, and only those. Mirrors the shape in `metrics.test.ts`
 * rather than running the full migration chain — a health report that needs V60 to be exercised
 * would be reading far more than it should.
 *
 * `modified_at` is `NOT NULL` here exactly as it is in `unified-item-v3-sql.ts`, which is the
 * whole reason the "missing modified_at" signal is the sentinel `0` and not `NULL`.
 */
function createMinimalSchema(db: Database): void {
  db.run(`
    CREATE TABLE item (
      id          TEXT PRIMARY KEY,
      service     TEXT NOT NULL,
      type        TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT,
      modified_at INTEGER NOT NULL,
      metadata    TEXT,
      synced_at   INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE embedding_chunk (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id     TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text  TEXT NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE sync_state (
      connector_id TEXT PRIMARY KEY,
      last_sync_at INTEGER
    )
  `);
}

let seq = 0;
function addItem(
  db: Database,
  opts: {
    service: string;
    type?: string;
    url?: string | null;
    modifiedAt?: number;
    metadata?: string | null;
    embedded?: boolean;
  },
): string {
  const id = `i${++seq}`;
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.service,
      opts.type ?? "doc",
      id,
      `title ${id}`,
      opts.url === undefined ? "https://example.com/x" : opts.url,
      opts.modifiedAt ?? NOW,
      opts.metadata === undefined ? '{"a":1}' : opts.metadata,
      NOW,
    ],
  );
  if (opts.embedded === true) {
    db.run(`INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text) VALUES (?, 0, 'c')`, [
      id,
    ]);
  }
  return id;
}

function setSync(db: Database, connectorId: string, lastSyncAt: number | null): void {
  db.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?)`, [
    connectorId,
    lastSyncAt,
  ]);
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  createMinimalSchema(db);
  seq = 0;
});

describe("collectIndexHealth — confidence score", () => {
  test("an EMPTY index reports confidence null, never 0", () => {
    // 0 would read as "your index is terrible"; the truth is "there is nothing to judge". This is
    // the one number a user acts on, so it must not editorialise about an index that does not
    // exist yet. `nimbus doctor` keys its message off this null, not off a low score.
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.totalItems).toBe(0);
    expect(h.confidence).toBeNull();
    expect(h.confidenceUnavailableReason).toBe("empty_index");
  });

  test("full coverage + everything fresh scores 100", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", embedded: true });
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidence).toBe(100);
  });

  test("zero coverage + everything fresh scores exactly the freshness weight", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidence).toBe(Math.round(FRESHNESS_WEIGHT * 100));
  });

  test("full coverage + everything stale scores exactly the coverage weight", () => {
    setSync(db, "github", NOW - 90 * DAY_MS);
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidence).toBe(Math.round(COVERAGE_WEIGHT * 100));
  });

  test("the two weights sum to 1, so the score cannot exceed 100", () => {
    expect(COVERAGE_WEIGHT + FRESHNESS_WEIGHT).toBeCloseTo(1, 10);
  });

  test("confidence discloses the two inputs it was derived from", () => {
    // A bare number invites the user to guess which half is bad. The report carries both.
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", embedded: true });
    addItem(db, { service: "github" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidenceInputs.embeddingCoveragePercent).toBe(50);
    expect(h.confidenceInputs.freshItemPercent).toBe(100);
  });
});

describe("collectIndexHealth — freshness is weighted by ITEMS, not by connector count", () => {
  test("one stale connector holding most items outweighs many fresh empty ones", () => {
    // The alternative — averaging over connectors — lets nine empty fresh connectors mask the one
    // holding 100 stale items, which is precisely the case a user needs told about.
    setSync(db, "jira", NOW - 90 * DAY_MS);
    for (let i = 0; i < 9; i++) setSync(db, `empty${i}`, NOW - DAY_MS);
    for (let i = 0; i < 10; i++) addItem(db, { service: "jira", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidenceInputs.freshItemPercent).toBe(0);
  });

  test("a NEVER-synced connector's items count as stale", () => {
    setSync(db, "slack", null);
    addItem(db, { service: "slack", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidenceInputs.freshItemPercent).toBe(0);
    const slack = h.connectors.find((c) => c.service === "slack");
    expect(slack?.lastSyncMs).toBeNull();
    expect(slack?.stale).toBe(true);
    expect(slack?.staleReason).toBe("never_synced");
  });

  test("items whose service has NO sync_state row count as stale and are disclosed", () => {
    // Fail-closed: an unknown sync time is not evidence of freshness. Silently treating it as
    // fresh would inflate the one number the user acts on.
    addItem(db, { service: "orphan", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.confidenceInputs.freshItemPercent).toBe(0);
    const orphan = h.connectors.find((c) => c.service === "orphan");
    expect(orphan?.stale).toBe(true);
    expect(orphan?.staleReason).toBe("no_sync_record");
  });

  test("the stale threshold is configurable and is echoed back in the report", () => {
    setSync(db, "github", NOW - 10 * DAY_MS);
    addItem(db, { service: "github", embedded: true });
    expect(
      collectIndexHealth(db, { nowMs: NOW, staleThresholdDays: 30 }).connectors[0]?.stale,
    ).toBe(false);
    const tight = collectIndexHealth(db, { nowMs: NOW, staleThresholdDays: 5 });
    expect(tight.connectors[0]?.stale).toBe(true);
    expect(tight.staleThresholdDays).toBe(5);
  });

  test("the default threshold is used when none is supplied", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github" });
    expect(collectIndexHealth(db, { nowMs: NOW }).staleThresholdDays).toBe(
      DEFAULT_STALE_THRESHOLD_DAYS,
    );
  });
});

describe("collectIndexHealth — per-connector embedding coverage", () => {
  test("coverage is computed per service, not copied from the global figure", () => {
    // The pre-existing `collectIndexMetrics` only ever had ONE coverage number, over the whole
    // index. Reporting that same number against every connector would look right on a
    // single-connector install and be wrong on every real one.
    setSync(db, "github", NOW - DAY_MS);
    setSync(db, "jira", NOW - DAY_MS);
    addItem(db, { service: "github", embedded: true });
    addItem(db, { service: "github", embedded: true });
    addItem(db, { service: "jira", embedded: true });
    addItem(db, { service: "jira" });
    addItem(db, { service: "jira" });
    addItem(db, { service: "jira" });

    const h = collectIndexHealth(db, { nowMs: NOW });
    const byService = new Map(h.connectors.map((c) => [c.service, c]));
    expect(byService.get("github")?.embeddingCoveragePercent).toBe(100);
    expect(byService.get("jira")?.embeddingCoveragePercent).toBe(25);
    // …and they genuinely differ from the global figure (3 of 6 embedded).
    expect(h.embeddingCoveragePercent).toBe(50);
  });

  test("multiple chunks for one item count that item ONCE", () => {
    setSync(db, "github", NOW - DAY_MS);
    const id = addItem(db, { service: "github", embedded: true });
    db.run(`INSERT INTO embedding_chunk (item_id, chunk_index, chunk_text) VALUES (?, 1, 'c2')`, [
      id,
    ]);
    addItem(db, { service: "github" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.connectors[0]?.embeddingCoveragePercent).toBe(50);
  });

  test("a connector with a sync row but no items reports 0% without dividing by zero", () => {
    setSync(db, "empty", NOW - DAY_MS);
    const h = collectIndexHealth(db, { nowMs: NOW });
    const empty = h.connectors.find((c) => c.service === "empty");
    expect(empty?.items).toBe(0);
    expect(empty?.embeddingCoveragePercent).toBe(0);
  });

  test("connectors are ordered by item count descending, so the biggest problem reads first", () => {
    setSync(db, "small", NOW - DAY_MS);
    setSync(db, "big", NOW - DAY_MS);
    addItem(db, { service: "small" });
    addItem(db, { service: "big" });
    addItem(db, { service: "big" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.connectors.map((c) => c.service)).toEqual(["big", "small"]);
  });
});

describe("collectIndexHealth — sparse metadata by item type", () => {
  test("counts a NULL url, a zero modified_at and a NULL metadata separately", () => {
    // `modified_at` is NOT NULL on the live `item` table, so "missing" is the sentinel 0 that
    // `item-store.ts` writes when a connector supplies neither modifiedAt nor createdAt.
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", type: "pr", url: null });
    addItem(db, { service: "github", type: "pr", modifiedAt: 0 });
    addItem(db, { service: "github", type: "pr", metadata: null });
    addItem(db, { service: "github", type: "pr" });

    const h = collectIndexHealth(db, { nowMs: NOW });
    const pr = h.sparseTypes.find((t) => t.type === "pr");
    expect(pr?.items).toBe(4);
    expect(pr?.missingUrl).toBe(1);
    expect(pr?.missingModifiedAt).toBe(1);
    expect(pr?.missingMetadata).toBe(1);
  });

  test("an empty-string metadata counts as missing, the way a NULL does", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", type: "pr", metadata: "" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.sparseTypes.find((t) => t.type === "pr")?.missingMetadata).toBe(1);
  });

  test("a type with every field populated is NOT reported as sparse", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", type: "clean" });
    addItem(db, { service: "github", type: "dirty", url: null });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.sparseTypes.map((t) => t.type)).toEqual(["dirty"]);
  });

  test("one item missing two fields is counted in both columns but is one item", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", type: "pr", url: null, metadata: null });
    const h = collectIndexHealth(db, { nowMs: NOW });
    const pr = h.sparseTypes.find((t) => t.type === "pr");
    expect(pr?.items).toBe(1);
    expect(pr?.missingUrl).toBe(1);
    expect(pr?.missingMetadata).toBe(1);
    // The item count is the denominator, so it must not be double-counted by the two misses.
    expect(pr?.sparseItems).toBe(1);
  });
});

describe("collectIndexHealth — defaults and defensive paths", () => {
  test("works with no options at all, defaulting nowMs and the threshold", () => {
    // The production caller passes `{}` when the RPC has no `staleThresholdDays`, so both
    // `?? Date.now()` and `?? DEFAULT_STALE_THRESHOLD_DAYS` are live paths, not dead defaults.
    setSync(db, "github", Date.now() - DAY_MS);
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db);
    expect(h.staleThresholdDays).toBe(DEFAULT_STALE_THRESHOLD_DAYS);
    expect(h.generatedAtMs).toBeGreaterThan(0);
    expect(h.connectors[0]?.stale).toBe(false);
  });

  test("a non-numeric last_sync_at is read as 'never synced', not as an age", () => {
    // SQLite is dynamically typed: nothing stops a stray string landing in an INTEGER column, and
    // arithmetic on it would produce NaN days rather than an honest 'never'.
    db.run(`INSERT INTO sync_state (connector_id, last_sync_at) VALUES ('weird', 'not-a-number')`);
    addItem(db, { service: "weird", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    const weird = h.connectors.find((c) => c.service === "weird");
    expect(weird?.lastSyncMs).toBeNull();
    expect(weird?.staleReason).toBe("never_synced");
    expect(weird?.staleDays).toBeNull();
  });

  test("connectors with equal item counts fall back to alphabetical order", () => {
    // Without the tie-break the order is whatever SQLite returns, which makes the output
    // non-deterministic between runs and any snapshot of it flaky.
    setSync(db, "zeta", NOW - DAY_MS);
    setSync(db, "alpha", NOW - DAY_MS);
    addItem(db, { service: "zeta" });
    addItem(db, { service: "alpha" });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.connectors.map((c) => c.service)).toEqual(["alpha", "zeta"]);
  });

  test("sparse types with equal counts fall back to alphabetical order", () => {
    setSync(db, "github", NOW - DAY_MS);
    addItem(db, { service: "github", type: "zeta", url: null });
    addItem(db, { service: "github", type: "alpha", url: null });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.sparseTypes.map((t) => t.type)).toEqual(["alpha", "zeta"]);
  });

  test("a future last_sync_at clamps to 0 days rather than reporting a negative age", () => {
    // Clock skew between the machine and a connector's timestamps is real; "-3d ago" is nonsense.
    setSync(db, "github", NOW + 5 * DAY_MS);
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.connectors[0]?.staleDays).toBe(0);
    expect(h.connectors[0]?.stale).toBe(false);
  });
});

describe("collectIndexHealth — staleness compares the UNROUNDED age", () => {
  test("an age just above the threshold is stale, even when it rounds down onto it", () => {
    // Caught in review: `staleDays` was rounded to one decimal BEFORE the comparison, so 7.04 days
    // became 7.0 and `7.0 > 7` was false — a connector past the threshold reported fresh. The
    // rounding is for display only; the verdict must use the raw age.
    const ageMs = (7 + 0.04) * DAY_MS;
    setSync(db, "github", NOW - ageMs);
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW, staleThresholdDays: 7 });
    expect(h.connectors[0]?.stale).toBe(true);
    expect(h.connectors[0]?.staleReason).toBe("threshold_exceeded");
    // …and the DISPLAYED value is still the friendly rounded one.
    expect(h.connectors[0]?.staleDays).toBe(7);
  });

  test("an age exactly at the threshold is NOT stale", () => {
    // The boundary is `>`, not `>=` — "stale after 7 days" must not fire at exactly 7.
    setSync(db, "github", NOW - 7 * DAY_MS);
    addItem(db, { service: "github", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW, staleThresholdDays: 7 });
    expect(h.connectors[0]?.stale).toBe(false);
  });

  test("an age just below the threshold is not stale", () => {
    setSync(db, "github", NOW - 6.99 * DAY_MS);
    addItem(db, { service: "github", embedded: true });
    expect(collectIndexHealth(db, { nowMs: NOW, staleThresholdDays: 7 }).connectors[0]?.stale).toBe(
      false,
    );
  });
});

describe("collectIndexHealth - excluded types (FinOps cost rows)", () => {
  test("cost_allocation rows are not counted as items or as un-embedded", () => {
    for (let i = 0; i < 5; i += 1) addItem(db, { service: "vantage", type: "cost_allocation" });
    addItem(db, { service: "vantage", type: "cost_recommendation", embedded: true });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.totalItems).toBe(1);
    const vantage = h.connectors.find((s) => s.service === "vantage");
    expect(vantage?.items).toBe(1);
    expect(vantage?.embeddedItems).toBe(1);
  });

  test("cost rows have no URL by design and never read as a sparse type", () => {
    for (let i = 0; i < 3; i += 1) {
      addItem(db, { service: "vantage", type: "cost_allocation", url: null });
    }
    addItem(db, { service: "vantage", type: "cost_recommendation", url: null });
    const h = collectIndexHealth(db, { nowMs: NOW });
    expect(h.sparseTypes).toEqual([]);
  });
});
