import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  configMap,
  HOUR,
  resolverFor,
  serviceConfig,
  writeCiRun,
} from "./__fixtures__/index-writers.ts";
import {
  writeJsmAlert,
  writePagerdutyIncident,
  writeSentryIssue,
} from "./__fixtures__/trigger-writers.ts";
import {
  BUCKET_MS,
  bucketStart,
  isAnomalous,
  MIN_BASELINE_BUCKETS,
  scoreBucket,
} from "./anomaly-baseline.ts";
import { countIndexBuckets, indexSeriesId } from "./anomaly-series.ts";

describe("scoreBucket (pure)", () => {
  test("null under 7 days of buckets", () => {
    expect(scoreBucket(new Array(MIN_BASELINE_BUCKETS - 1).fill(0), 9)).toBeNull();
    expect(isAnomalous(null, 9, 3)).toBe(false);
  });

  test("a flat zero series needs z events in an hour (sd floored at 1)", () => {
    const h = new Array(MIN_BASELINE_BUCKETS).fill(0);
    expect(isAnomalous(scoreBucket(h, 2), 2, 3)).toBe(false);
    expect(isAnomalous(scoreBucket(h, 3), 3, 3)).toBe(true);
  });

  test("scores against mean and sd; only an increase counts", () => {
    const h = Array.from({ length: MIN_BASELINE_BUCKETS }, (_, i) => (i % 2 === 0 ? 10 : 30));
    const s = scoreBucket(h, 70);
    expect(s?.mean).toBe(20);
    expect(s?.sd).toBe(10);
    expect(s?.z).toBe(5);
    expect(isAnomalous(s, 70, 5)).toBe(true);
    expect(isAnomalous(scoreBucket(h, -30), -30, 3)).toBe(false);
  });

  test("bucketStart floors to the hour", () => {
    expect(bucketStart(BUCKET_MS * 5 + 17)).toBe(BUCKET_MS * 5);
  });
});

describe("countIndexBuckets", () => {
  let db: Database;
  const cfg = serviceConfig();
  const FROM = Date.parse("2026-11-10T00:00:00.000Z");
  const value = (
    buckets: { seriesId: string; bucketStartMs: number; value: number }[],
    s: string,
    b: number,
  ) => buckets.find((x) => x.seriesId === s && x.bucketStartMs === b)?.value;

  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  test("counts triggers by opened hour and failed runs by time, zeros included", () => {
    const r = resolverFor(cfg);
    writeSentryIssue(db, { id: "s1", firstSeenMs: FROM + 10, lastSeenMs: FROM + 5 * HOUR }, r);
    writeSentryIssue(db, { id: "s2", firstSeenMs: FROM + 20, project: "other" }, r);
    writePagerdutyIncident(db, { id: "P1", openedAtMs: FROM + HOUR + 1 }, r);
    writeJsmAlert(db, { id: "a1", openedAtMs: FROM + HOUR + 2, tags: ["payments"] }, r);
    writeCiRun(db, r, { runId: 1, conclusion: "failure", atMs: FROM + 2 * HOUR });
    writeCiRun(db, r, { runId: 2, conclusion: "success", atMs: FROM + 2 * HOUR });
    const out = countIndexBuckets(db, configMap(cfg), FROM, FROM + 3 * HOUR);
    if (out.kind !== "ok") throw new Error("capped");
    expect(out.buckets).toHaveLength(9);
    const s = "payment-service";
    expect(value(out.buckets, indexSeriesId("errors", s), FROM)).toBe(1);
    expect(value(out.buckets, indexSeriesId("alerts", s), FROM + HOUR)).toBe(2);
    expect(value(out.buckets, indexSeriesId("ci_failed", s), FROM + 2 * HOUR)).toBe(1);
    expect(value(out.buckets, indexSeriesId("errors", s), FROM + HOUR)).toBe(0);
  });

  test("an event outside the range is not counted", () => {
    const r = resolverFor(cfg);
    writeSentryIssue(db, { id: "old", firstSeenMs: FROM - 1, lastSeenMs: FROM + HOUR }, r);
    const out = countIndexBuckets(db, configMap(cfg), FROM, FROM + HOUR);
    if (out.kind !== "ok") throw new Error("capped");
    expect(out.buckets.every((b) => b.value === 0)).toBe(true);
  });

  test("a scan cut by its cap returns capped and no buckets", () => {
    const r = resolverFor(cfg);
    writeCiRun(db, r, { runId: 1, conclusion: "failure", atMs: FROM });
    writeCiRun(db, r, { runId: 2, conclusion: "failure", atMs: FROM + 1 });
    expect(countIndexBuckets(db, configMap(cfg), FROM, FROM + HOUR, 1)).toEqual({ kind: "capped" });
    writeSentryIssue(db, { id: "x1", firstSeenMs: FROM }, r);
    writeSentryIssue(db, { id: "x2", firstSeenMs: FROM }, r);
    expect(countIndexBuckets(db, configMap(cfg), FROM + 2 * HOUR, FROM + 3 * HOUR, 1).kind).toBe(
      "ok",
    );
  });

  test("malformed, non-object, missing or time-less metadata is skipped, never counted", () => {
    const raw = (id: string, service: string, type: string, metadata: string | null): void => {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES (?, ?, ?, ?, 't', ?, ?, ?)`,
        [id, service, type, id, FROM + 10, FROM + 10, metadata],
      );
    };
    raw("sentry:a", "sentry", "error_issue", null);
    raw("sentry:b", "sentry", "error_issue", "{not json");
    raw("sentry:c", "sentry", "error_issue", "[1,2]");
    raw("sentry:d", "sentry", "error_issue", JSON.stringify({ project: "payments-api" }));
    raw("github_actions:e", "github_actions", "ci_run", null);
    raw(
      "github_actions:f",
      "github_actions",
      "ci_run",
      JSON.stringify({ conclusion: "failure", repo: "acme/other" }),
    );
    const out = countIndexBuckets(db, configMap(cfg), FROM, FROM + HOUR);
    if (out.kind !== "ok") throw new Error("capped");
    expect(out.buckets.every((b) => b.value === 0)).toBe(true);
  });

  test("no configured service means no series", () => {
    const out = countIndexBuckets(db, new Map(), FROM, FROM + HOUR);
    expect(out).toEqual({ kind: "ok", buckets: [] });
  });
});
