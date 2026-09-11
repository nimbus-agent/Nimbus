/**
 * End-to-end tests for `GET /v1/metrics/stats` — one DORA-family metric as a bucketed time
 * series, so a client can draw a line rather than three overlapping windows.
 *
 * Sibling of `metrics-dora-route.test.ts`: same fixture, same public mount, same config seam.
 * The design doc was pruned with the rest of the delivered set; the shipped behaviour is described
 * in `docs/CHANGELOG.md`'s 2026-09-11 entry.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { startReadOnlyHttpServer } from "../../../src/ipc/http-server.ts";
import {
  FIXTURE_NOW_MS,
  seedPaymentServiceFixture,
} from "../../fixtures/dora/payment-service/seed.ts";
import { seedDbFile } from "../../helpers/migrated-db-seed.ts";

const DAY = 86_400_000;

type StatsPoint = {
  start_ms: number;
  end_ms: number;
  value: number | null;
  unit: string;
  sample: number;
  gap: string | null;
};
type StatsBody = {
  metric: string;
  service: string;
  window: { since_ms: number; until_ms: number };
  bucket_ms: number;
  points: StatsPoint[];
};

const VALID_TOML = `[metrics.dora.payment-service]
repos = ["github:nimbus-agent/payments", "gitlab:nimbus-agent/payments", "jenkins:payment-service/deploy-prod"]
pagerduty_services = ["P12ABCD"]
`;

describe("GET /v1/metrics/stats", () => {
  let dir: string;
  let handle: ReturnType<typeof startReadOnlyHttpServer> | undefined;
  let port: number;

  async function start(toml: string): Promise<void> {
    const dbPath = join(dir, "nimbus.db");
    seedDbFile(dbPath, CURRENT_SCHEMA_VERSION);
    const db = new Database(dbPath);
    await seedPaymentServiceFixture(db);
    db.close();
    writeFileSync(join(dir, "nimbus.toml"), toml);
    handle = startReadOnlyHttpServer(dbPath, 0, {
      configDir: dir,
      nowMs: () => FIXTURE_NOW_MS,
    });
    port = handle.port;
  }

  function get(query: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/v1/metrics/stats?${query}`);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-stats-http-"));
  });

  afterEach(() => {
    handle?.stop();
    handle = undefined;
    try {
      // maxRetries: 0 / retryDelay: 0 — see metrics-dora-route.test.ts (#972, #973).
      rmSync(dir, { recursive: true, force: true, maxRetries: 0, retryDelay: 0 });
    } catch {
      /* non-fatal */
    }
  });

  it("returns disjoint buckets covering the requested window", async () => {
    await start(VALID_TOML);
    const res = await get(
      `service=payment-service&metric=deployment-frequency&window_ms=${28 * DAY}&bucket_ms=${7 * DAY}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsBody;
    expect(body.metric).toBe("deployment-frequency");
    expect(body.service).toBe("payment-service");
    expect(body.bucket_ms).toBe(7 * DAY);
    expect(body.points).toHaveLength(4);
    // Disjoint and contiguous is the whole point of the route — a client draws a line across
    // these, which a nested-window series could not support.
    for (let i = 1; i < body.points.length; i += 1) {
      expect(body.points[i]?.start_ms).toBe(body.points[i - 1]?.end_ms as number);
    }
    expect(body.points[0]?.start_ms).toBe(body.window.since_ms);
    expect(body.points[body.points.length - 1]?.end_ms).toBe(body.window.until_ms);
    expect(body.window.until_ms - body.window.since_ms).toBe(28 * DAY);
  });

  it("pins the wire key set of the series and of a point", async () => {
    await start(VALID_TOML);
    const body = (await (
      await get(`service=payment-service&metric=mttr&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`)
    ).json()) as StatsBody;
    expect(Object.keys(body).sort()).toEqual([
      "bucket_ms",
      "metric",
      "points",
      "service",
      "window",
    ]);
    expect(Object.keys(body.points[0] as object).sort()).toEqual([
      "end_ms",
      "gap",
      "sample",
      "start_ms",
      "unit",
      "value",
    ]);
  });

  it("serves every metric id the enum advertises", async () => {
    await start(VALID_TOML);
    for (const metric of [
      "deployment-frequency",
      "lead-time",
      "change-failure-rate",
      "mttr",
      "pr-merges",
      "incidents-opened",
    ]) {
      const res = await get(
        `service=payment-service&metric=${metric}&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as StatsBody).metric).toBe(metric);
    }
  });

  it("is reachable with no bearer token", async () => {
    await start(VALID_TOML);
    // Public by decision, beside /v1/metrics/dora. Asserted rather than assumed, because the
    // sibling GET /v1/services/resolve deliberately lands the other way.
    const res = await get(
      `service=payment-service&metric=mttr&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`,
    );
    expect(res.status).toBe(200);
  });

  it("refuses an unknown service rather than rendering empty buckets", async () => {
    await start(VALID_TOML);
    // Deliberately unlike /v1/metrics/dora, which answers softly with `unknown_service`: a
    // series whose bucket count and unit depend on config it does not have has nothing honest
    // to place-hold, and N empty buckets look like thin data rather than a typo.
    const res = await get(`service=nope&metric=mttr&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("nope");
  });

  it("refuses each missing required param, naming ONLY the one that is missing", async () => {
    await start(VALID_TOML);
    // The negative half is the point. `window_ms` and `bucket_ms` were originally checked with
    // one combined `||` whose message named BOTH, so a caller who omitted only `bucket_ms` was
    // told `window_ms` was missing too. A `toContain(named)` assertion passes against that
    // message for every case — it is a test that cannot fail. Asserting the OTHER params are
    // absent from the message is what catches it.
    const all = ["service", "metric", "window_ms", "bucket_ms"] as const;
    const cases: readonly [string, (typeof all)[number]][] = [
      [`metric=mttr&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`, "service"],
      [`service=payment-service&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`, "metric"],
      [`service=payment-service&metric=mttr&bucket_ms=${7 * DAY}`, "window_ms"],
      [`service=payment-service&metric=mttr&window_ms=${14 * DAY}`, "bucket_ms"],
    ];
    for (const [query, missing] of cases) {
      const res = await get(query);
      expect(res.status).toBe(400);
      const { error } = (await res.json()) as { error: string };
      expect(error).toContain(missing);
      for (const other of all) {
        if (other === missing) continue;
        // No name in this set is a substring of another, so plain containment is a sound
        // negative check.
        expect(error).not.toContain(other);
      }
    }
  });

  it("refuses an unknown metric and names the valid ids", async () => {
    await start(VALID_TOML);
    const res = await get(
      `service=payment-service&metric=uptime&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("deployment-frequency");
  });

  it("refuses a non-integer window as a bad param, not a server error", async () => {
    await start(VALID_TOML);
    // Number("abc") is NaN, which requireStatsParams rejects with its own message. The handler
    // deliberately does not pre-validate, so this proves the conversion reaches that check.
    const res = await get(`service=payment-service&metric=mttr&window_ms=abc&bucket_ms=${7 * DAY}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("integer milliseconds");
  });

  it("refuses an unusable bucket shape with an actionable message", async () => {
    await start(VALID_TOML);
    // A bucket wider than the window, and a series over the 400-bucket ceiling.
    const wide = await get(
      `service=payment-service&metric=mttr&window_ms=${DAY}&bucket_ms=${7 * DAY}`,
    );
    expect(wide.status).toBe(400);
    const tooMany = await get(
      `service=payment-service&metric=mttr&window_ms=${500 * DAY}&bucket_ms=${DAY}`,
    );
    expect(tooMany.status).toBe(400);
    expect(((await tooMany.json()) as { error: string }).error.length).toBeGreaterThan(0);
  });

  it("surfaces a malformed nimbus.toml without echoing any config value", async () => {
    await start(`[metrics.dora.super-secret-service]
repos = ["github:nimbus-agent/payments"]
deploy_environments = ["staging-EU!"]
`);
    const res = await get(
      `service=payment-service&metric=mttr&window_ms=${14 * DAY}&bucket_ms=${7 * DAY}`,
    );
    // 500 rather than a degraded empty series: a series of empty buckets would read as "no
    // data" when the truth is "your config does not parse".
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw)).toEqual({ error: "config_unreadable" });
    // The parser's own message embeds the service id AND the offending value, and this route
    // is PUBLIC — so neither may cross the wire.
    expect(raw).not.toContain("super-secret-service");
    expect(raw).not.toContain("staging-EU");
  });
});
