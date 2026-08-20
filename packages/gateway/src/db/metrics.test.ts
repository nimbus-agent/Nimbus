import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { PR_CHANGED_FILE_V55_SQL } from "../index/pr-changed-file-v55-sql.ts";
import { latencyRingBuffer } from "./latency-ring-buffer.ts";
import { collectIndexMetrics } from "./metrics.ts";

// ---------------------------------------------------------------------------
// Minimal real-DB schema used by collectIndexMetrics (no full migration needed)
// ---------------------------------------------------------------------------
function createMinimalSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS item (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL,
      type TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      body_complete INTEGER NOT NULL DEFAULT 0,
      modified_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS embedding_chunk (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      model TEXT NOT NULL,
      dims INTEGER NOT NULL,
      embedded_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS sync_state (
      connector_id TEXT PRIMARY KEY,
      last_sync_at INTEGER
    )
  `);
  // collectIndexMetrics reads PR file coverage via collectPrFileCoverage, which queries
  // pr_files_state unconditionally — these tables must exist even for tests that don't
  // otherwise touch PR coverage.
  db.exec(PR_CHANGED_FILE_V55_SQL);
}

// ---------------------------------------------------------------------------
// Helpers: minimal fake Database-shaped objects for defensive-branch testing
// ---------------------------------------------------------------------------

// A fake .query(sql) that returns a statement-like object whose .all()/.get()
// delegates to the provided impl keyed on the SQL string.
type FakeQueryResult = Array<Record<string, unknown>> | undefined | null | Record<string, unknown>;

function makeFakeDb(
  queryImpl: (sql: string) => { all?: () => FakeQueryResult; get?: () => FakeQueryResult },
): unknown {
  return {
    query(sql: string) {
      const impl = queryImpl(sql);
      return {
        all: impl.all ?? (() => []),
        get: impl.get ?? (() => null),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Drain any in-flight ring-buffer samples before each test so latency fields
// are stable (all zeros when no query_latency_log table exists).
// ---------------------------------------------------------------------------
beforeEach(() => {
  latencyRingBuffer.drainOrdered();
});

afterEach(() => {
  latencyRingBuffer.drainOrdered();
});

// ===========================================================================
// Happy-path tests with real in-memory SQLite
// ===========================================================================

describe("collectIndexMetrics — real SQLite happy paths", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    createMinimalSchema(db);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  });

  test("empty index returns all-zero aggregates", () => {
    const m = collectIndexMetrics(db);
    expect(m.totalItems).toBe(0);
    expect(m.itemCountByService).toEqual({});
    // embeddingCoveragePercent: totalItems === 0 → 0 (covers the false arm of totalItems > 0)
    expect(m.embeddingCoveragePercent).toBe(0);
    expect(m.lastSuccessfulSyncByConnector).toEqual({});
    expect(m.indexSizeBytes).toBeGreaterThanOrEqual(0);
    expect(m.queryLatencyP50Ms).toBe(0);
    expect(m.queryLatencyP95Ms).toBe(0);
    expect(m.queryLatencyP99Ms).toBe(0);
  });

  test("items grouped by service are counted correctly", () => {
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at) VALUES ('i1','github','pr','e1','T1',1,1)`,
    );
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at) VALUES ('i2','github','pr','e2','T2',2,2)`,
    );
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at) VALUES ('i3','slack','message','e3','T3',3,3)`,
    );

    const m = collectIndexMetrics(db);
    expect(m.totalItems).toBe(3);
    expect(m.itemCountByService["github"]).toBe(2);
    expect(m.itemCountByService["slack"]).toBe(1);
  });

  test("embeddingCoveragePercent is non-zero when items exist with embeddings", () => {
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at) VALUES ('i1','svc','note','e1','T1',1,1)`,
    );
    db.run(
      `INSERT INTO embedding_chunk (item_id,chunk_index,chunk_text,model,dims,embedded_at) VALUES ('i1',0,'hello','test',384,1)`,
    );

    const m = collectIndexMetrics(db);
    // 1 item with emb out of 1 total → 100%
    expect(m.embeddingCoveragePercent).toBe(100);
    // covers totalItems > 0 → true arm
  });

  test("embeddingCoveragePercent is 0 when items exist but no embeddings", () => {
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at) VALUES ('i1','svc','note','e1','T1',1,1)`,
    );

    const m = collectIndexMetrics(db);
    // 0 emb out of 1 total → 0%
    expect(m.embeddingCoveragePercent).toBe(0);
  });

  test("lastSuccessfulSyncByConnector: numeric last_sync_at → Date", () => {
    const ts = 1_700_000_000_000;
    db.run(`INSERT INTO sync_state VALUES ('github-connector', ${ts})`);

    const m = collectIndexMetrics(db);
    const d = m.lastSuccessfulSyncByConnector["github-connector"];
    expect(d).toBeInstanceOf(Date);
    expect((d as Date).getTime()).toBe(ts);
  });

  test("lastSuccessfulSyncByConnector: NULL last_sync_at → null", () => {
    db.run(`INSERT INTO sync_state VALUES ('slack-connector', NULL)`);

    const m = collectIndexMetrics(db);
    expect(m.lastSuccessfulSyncByConnector["slack-connector"]).toBeNull();
  });

  test("indexSizeBytes is a non-negative integer", () => {
    const m = collectIndexMetrics(db);
    expect(m.indexSizeBytes).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(m.indexSizeBytes)).toBe(true);
  });

  test("index metrics report PR changed-file coverage", () => {
    db.exec(
      `INSERT INTO item (id, service, type, external_id, modified_at, title, synced_at)
       VALUES ('p1','github','pr','o/r#1',1,'PR #1',1)`,
    );
    db.exec(
      `INSERT INTO pr_files_state (item_id, fetched_at_ms, api_file_count, stored_count)
       VALUES ('p1',1,2,2)`,
    );
    const m = collectIndexMetrics(db);
    expect(m.prFileCoverage).toEqual({ covered: 1, totalPrs: 1, truncated: 0 });
  });
});

// ===========================================================================
// Defensive-branch tests via type-safe fake DB objects
// ===========================================================================

describe("collectIndexMetrics — defensive branches via type-safe fakes", () => {
  // -------------------------------------------------------------------------
  // line 34 — byServiceRows ?? [] — the ?? RIGHT arm: .all() returns undefined
  // -------------------------------------------------------------------------
  test("line 34: byServiceRows ?? [] right arm — .all() returns undefined → empty counts", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("GROUP BY service")) {
        // Simulate the raw cast returning undefined (defensive guard)
        return { all: () => undefined };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        return { get: () => ({ with_emb: 0 }) };
      }
      if (sql.includes("sync_state")) {
        return { all: () => [] };
      }
      // pageStats + latency queries return safe defaults
      return { get: () => ({ b: 0 }), all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    expect(m.totalItems).toBe(0);
    expect(m.itemCountByService).toEqual({});
  });

  // -------------------------------------------------------------------------
  // line 46 — withEmbRow?.with_emb ?? 0 — the ?? 0 RIGHT arm: .get() returns null
  // -------------------------------------------------------------------------
  test("line 46: withEmbRow?.with_emb ?? 0 right arm — .get() returns null → withEmb = 0", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("GROUP BY service")) {
        return { all: () => [{ service: "svc", c: 2 }] };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        // Simulate the raw cast returning null (defensive guard)
        return { get: () => null };
      }
      if (sql.includes("sync_state")) {
        return { all: () => [] };
      }
      return { get: () => ({ b: 8192 }), all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    // totalItems = 2, withEmb falls back to 0 → coverage = 0%
    expect(m.totalItems).toBe(2);
    expect(m.embeddingCoveragePercent).toBe(0);
  });

  // -------------------------------------------------------------------------
  // line 53 — syncRows ?? [] — the ?? RIGHT arm: .all() returns undefined
  // -------------------------------------------------------------------------
  test("line 53: syncRows ?? [] right arm — .all() returns undefined → empty sync map", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("GROUP BY service")) {
        return { all: () => [] };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        return { get: () => ({ with_emb: 0 }) };
      }
      if (sql.includes("sync_state")) {
        // Simulate the raw cast returning undefined (defensive guard)
        return { all: () => undefined };
      }
      return { get: () => ({ b: 4096 }), all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    expect(m.lastSuccessfulSyncByConnector).toEqual({});
  });

  // -------------------------------------------------------------------------
  // line 25 — pageStats: typeof b !== "number" guard → returns 0
  // The row exists but b is a non-number (e.g. a string) — covers the false arm.
  // -------------------------------------------------------------------------
  test("line 25: pageStats false arm — row.b is not a number → indexSizeBytes = 0", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("pragma_page_count")) {
        // b is a string, not a number → typeof b !== "number" → returns 0
        return { get: () => ({ b: "not-a-number" }) };
      }
      if (sql.includes("GROUP BY service")) {
        return { all: () => [] };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        return { get: () => ({ with_emb: 0 }) };
      }
      if (sql.includes("sync_state")) {
        return { all: () => [] };
      }
      return { get: () => null, all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    expect(m.indexSizeBytes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // line 25 — pageStats: b is not finite (NaN) → covers Number.isFinite guard
  // -------------------------------------------------------------------------
  test("line 25: pageStats false arm — row.b is NaN (non-finite) → indexSizeBytes = 0", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("pragma_page_count")) {
        return { get: () => ({ b: Number.NaN }) };
      }
      if (sql.includes("GROUP BY service")) {
        return { all: () => [] };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        return { get: () => ({ with_emb: 0 }) };
      }
      if (sql.includes("sync_state")) {
        return { all: () => [] };
      }
      return { get: () => null, all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    expect(m.indexSizeBytes).toBe(0);
  });

  // -------------------------------------------------------------------------
  // line 25 — pageStats: row itself is null → b is undefined → covers false arm
  // -------------------------------------------------------------------------
  test("line 25: pageStats false arm — .get() returns null → b is undefined → indexSizeBytes = 0", () => {
    const fake = makeFakeDb((sql) => {
      if (sql.includes("pragma_page_count")) {
        return { get: () => null };
      }
      if (sql.includes("GROUP BY service")) {
        return { all: () => [] };
      }
      if (sql.includes("COUNT(DISTINCT")) {
        return { get: () => ({ with_emb: 0 }) };
      }
      if (sql.includes("sync_state")) {
        return { all: () => [] };
      }
      return { get: () => null, all: () => [] };
    });

    const m = collectIndexMetrics(fake as unknown as Database);
    expect(m.indexSizeBytes).toBe(0);
  });
});
