import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "../../../src/index/local-index.ts";
import { collectTelemetryDbAggregates } from "../../../src/telemetry/db-aggregates.ts";

describe("collectTelemetryDbAggregates", () => {
  test("aggregates sync failures, durations, health transitions, extensions", () => {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    const now = Date.now();
    db.run(
      `INSERT INTO sync_telemetry (service, started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg)
       VALUES ('github', ?, 120, 0, 0, NULL, 0, 'timeout'),
              ('github', ?, 80, 0, 0, NULL, 0, NULL)`,
      [now - 1000, now - 2000],
    );
    db.run(
      `INSERT INTO connector_health_history (connector_id, from_state, to_state, reason, occurred_at)
       VALUES ('github', 'healthy', 'degraded', 'transient', ?)`,
      [now - 500],
    );
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('ext.demo', '1.0.0', '/x', 'a', 'b', 1, ?, ?)`,
      [now, now],
    );

    const ag = collectTelemetryDbAggregates(db);
    expect(ag.connector_error_rate["github"]).toBe(1);
    expect(ag.sync_duration_p50_ms["github"]).toBe(100);
    expect(ag.connector_health_transitions["degraded"]).toBe(1);
    expect(ag.extension_installs_by_id["ext.demo"]).toBe(1);
  });
});

describe("collectTelemetryDbAggregates — bounds and skips", () => {
  const SEVEN_D_MS = 7 * 24 * 60 * 60 * 1000;

  function freshDb(): Database {
    const db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    return db;
  }

  function insertSync(
    db: Database,
    service: string,
    startedAt: number,
    durationMs: number,
    errorMsg: string | null,
  ): void {
    db.run(
      `INSERT INTO sync_telemetry (service, started_at, duration_ms, items_upserted, items_deleted, bytes_transferred, had_more, error_msg)
       VALUES (?, ?, ?, 0, 0, NULL, 0, ?)`,
      [service, startedAt, durationMs, errorMsg],
    );
  }

  // Telemetry is a rolling 7-day slice, not a lifetime total. If the cutoff
  // stopped being applied, every aggregate would grow without bound and the
  // payload would start describing activity the user has long forgotten.
  test("excludes sync rows older than the 7-day window", () => {
    const db = freshDb();
    const now = Date.now();
    insertSync(db, "github", now - SEVEN_D_MS - 60_000, 900, "old failure");
    insertSync(db, "github", now - 1000, 100, null);

    const ag = collectTelemetryDbAggregates(db);
    expect(ag.connector_error_rate["github"]).toBeUndefined();
    expect(ag.sync_duration_p50_ms["github"]).toBe(100);
  });

  test("excludes health transitions older than the 7-day window", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO connector_health_history (connector_id, from_state, to_state, reason, occurred_at)
       VALUES ('github', 'healthy', 'degraded', 'old', ?)`,
      [now - SEVEN_D_MS - 60_000],
    );
    expect(collectTelemetryDbAggregates(db).connector_health_transitions).toEqual({});
  });

  test("takes the middle sample as p50 for an odd number of runs", () => {
    const db = freshDb();
    const now = Date.now();
    for (const d of [500, 100, 300]) insertSync(db, "jira", now - 1000, d, null);
    expect(collectTelemetryDbAggregates(db).sync_duration_p50_ms["jira"]).toBe(300);
  });

  test("counts an empty error_msg as a success, not a failure", () => {
    const db = freshDb();
    insertSync(db, "jira", Date.now() - 1000, 50, "");
    const ag = collectTelemetryDbAggregates(db);
    expect(ag.connector_error_rate["jira"]).toBeUndefined();
    expect(ag.sync_duration_p50_ms["jira"]).toBe(50);
  });

  test("clamps a negative duration to zero rather than emitting it", () => {
    const db = freshDb();
    insertSync(db, "jira", Date.now() - 1000, -5, null);
    expect(collectTelemetryDbAggregates(db).sync_duration_p50_ms["jira"]).toBe(0);
  });

  test("skips sync rows whose service is blank", () => {
    const db = freshDb();
    insertSync(db, "   ", Date.now() - 1000, 100, "boom");
    const ag = collectTelemetryDbAggregates(db);
    expect(ag.connector_error_rate).toEqual({});
    expect(ag.sync_duration_p50_ms).toEqual({});
  });

  test("skips health transitions whose to_state is blank", () => {
    const db = freshDb();
    db.run(
      `INSERT INTO connector_health_history (connector_id, from_state, to_state, reason, occurred_at)
       VALUES ('github', 'healthy', '  ', NULL, ?)`,
      [Date.now() - 1000],
    );
    expect(collectTelemetryDbAggregates(db).connector_health_transitions).toEqual({});
  });

  // A disabled extension is not an install this user is running. Reporting it
  // would overstate the installed base and leak the id of something they
  // deliberately turned off.
  test("reports only enabled extensions", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('ext.on', '1.0.0', '/x', 'a', 'b', 1, ?, ?), ('ext.off', '1.0.0', '/y', 'c', 'd', 0, ?, ?)`,
      [now, now, now, now],
    );
    expect(collectTelemetryDbAggregates(db).extension_installs_by_id).toEqual({ "ext.on": 1 });
  });

  test("skips an extension whose id is blank", () => {
    const db = freshDb();
    const now = Date.now();
    db.run(
      `INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at)
       VALUES ('   ', '1.0.0', '/x', 'a', 'b', 1, ?, ?)`,
      [now, now],
    );
    expect(collectTelemetryDbAggregates(db).extension_installs_by_id).toEqual({});
  });

  // The collector can run against a database that predates the migration which
  // created any of these three tables. It must degrade to empty slices, never
  // throw a `no such table` out of the telemetry path.
  test("returns empty slices against a database with none of the three tables", () => {
    const db = new Database(":memory:");
    expect(collectTelemetryDbAggregates(db)).toEqual({
      connector_error_rate: {},
      connector_health_transitions: {},
      sync_duration_p50_ms: {},
      extension_installs_by_id: {},
    });
  });
});
