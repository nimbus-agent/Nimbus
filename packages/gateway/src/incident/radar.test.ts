import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Expectation } from "../config/incident-predict-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  configMap,
  HOUR,
  resolverFor,
  serviceConfig,
  T0,
  writeCiRun,
  writeDeployment,
} from "./__fixtures__/index-writers.ts";
import { evaluateRadar } from "./radar.ts";
import { CI_SCAN_CAP, radarReader } from "./radar-read.ts";

const exp = (over: Partial<Expectation>): Expectation => ({
  key: "deploy:payment-service",
  kind: "deploy",
  service: "payment-service",
  type: null,
  maxGapMs: 2 * HOUR,
  ...over,
});

describe("evaluateRadar (pure)", () => {
  test("never seen and too old are overdue; recent is ok; unknown is unknown", () => {
    const a = exp({ key: "a" });
    const b = exp({ key: "b" });
    const c = exp({ key: "c" });
    const d = exp({ key: "d" });
    const last = new Map([
      ["a", { known: true as const, atMs: null }],
      ["b", { known: true as const, atMs: T0 - 3 * HOUR }],
      ["c", { known: true as const, atMs: T0 - HOUR }],
      ["d", { known: false as const }],
    ]);
    const out = evaluateRadar([a, b, c, d], (e) => last.get(e.key) ?? { known: false }, T0);
    expect(out.map((v) => v.state)).toEqual(["overdue", "overdue", "ok", "unknown"]);
    expect(out[2]?.lastAtMs).toBe(T0 - HOUR);
  });

  test("exactly max_gap is not yet overdue", () => {
    const out = evaluateRadar([exp({})], () => ({ known: true, atMs: T0 - 2 * HOUR }), T0);
    expect(out[0]?.state).toBe("ok");
  });
});

describe("radarReader (the index)", () => {
  let db: Database;
  const cfg = serviceConfig();
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  test("deploy reads the last successful deployment of the service", () => {
    const read = radarReader(db, configMap(cfg));
    expect(read(exp({}))).toEqual({ known: true, atMs: null });
    writeDeployment(db, resolverFor(cfg), { startedAtMs: T0 - HOUR });
    expect(radarReader(db, configMap(cfg))(exp({}))).toEqual({ known: true, atMs: T0 - HOUR });
  });

  test("ci_success binds runs to the service and ignores failures", () => {
    const r = resolverFor(cfg);
    writeCiRun(db, r, { runId: 1, conclusion: "success", atMs: T0 - 5 * HOUR });
    writeCiRun(db, r, { runId: 2, conclusion: "failure", atMs: T0 - HOUR });
    writeCiRun(db, r, { runId: 3, repo: "acme/other", conclusion: "success", atMs: T0 });
    const read = radarReader(db, configMap(cfg));
    expect(read(exp({ kind: "ci_success" }))).toEqual({ known: true, atMs: T0 - 5 * HOUR });
    expect(read(exp({ kind: "ci_success", service: "other" }))).toEqual({
      known: true,
      atMs: null,
    });
  });

  test("ci_success is unknown when the scan cap is hit with no match", () => {
    const r = resolverFor(cfg);
    db.transaction(() => {
      for (let i = 0; i <= CI_SCAN_CAP; i++) {
        writeCiRun(db, r, { runId: 10_000 + i, conclusion: "failure", atMs: T0 - i });
      }
    })();
    expect(radarReader(db, configMap(cfg))(exp({ kind: "ci_success" }))).toEqual({ known: false });
  });

  test("sync reads the newest error-free sync's end; item reads the newest item of the pair", () => {
    db.run(
      `INSERT INTO sync_telemetry (service, started_at, duration_ms, items_upserted, error_msg) VALUES
        ('github', ?, 100, 1, NULL), ('github', ?, 100, 0, 'boom')`,
      [T0 - HOUR, T0],
    );
    const read = radarReader(db, configMap(cfg));
    expect(read(exp({ kind: "sync", service: "github" }))).toEqual({
      known: true,
      atMs: T0 - HOUR + 100,
    });
    expect(read(exp({ kind: "sync", service: "slack" }))).toEqual({ known: true, atMs: null });
    writeCiRun(db, resolverFor(cfg), { atMs: T0 - 2 });
    expect(read(exp({ kind: "item", service: "github_actions", type: "ci_run" }))).toEqual({
      known: true,
      atMs: T0 - 2,
    });
  });
});
