import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openSeededInMemoryDb } from "../../test/helpers/migrated-db-seed.ts";
import { transitionHealth } from "../connectors/health.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { type MetricsServerHandle, startMetricsServer } from "./metrics-server.ts";

function makeDbWithItems(items: Array<{ id: string; service: string }>): Database {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  const now = Date.now();
  for (const it of items) {
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES (?, ?, 'doc', ?, 't', ?, ?)`,
      [it.id, it.service, `ext:${it.id}`, now, now],
    );
  }
  return db;
}

async function get(port: number, path: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}${path}`);
}

describe("startMetricsServer", () => {
  let db: Database;
  let handle: MetricsServerHandle | null = null;

  beforeEach(() => {
    db = makeDbWithItems([
      { id: "g1", service: "github" },
      { id: "g2", service: "github" },
      { id: "s1", service: "slack" },
    ]);
  });

  afterEach(() => {
    handle?.stop();
    handle = null;
    db.close();
  });

  test("handle exposes the OS-assigned port when started with port 0", () => {
    handle = startMetricsServer(() => db, 0);
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.port).toBeLessThanOrEqual(65535);
  });

  test("/healthz returns 200 ok", async () => {
    handle = startMetricsServer(() => db, 0);
    const res = await get(handle.port, "/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok\n");
  });

  test("unknown path returns 404 Not Found", async () => {
    handle = startMetricsServer(() => db, 0);
    const res = await get(handle.port, "/nope");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
  });

  test("/metrics returns 200 with Prometheus content-type", async () => {
    handle = startMetricsServer(() => db, 0);
    const res = await get(handle.port, "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
  });

  test("/metrics emits per-service item gauges with HELP and TYPE", async () => {
    handle = startMetricsServer(() => db, 0);
    const body = await (await get(handle.port, "/metrics")).text();
    expect(body).toContain("# HELP nimbus_index_items_total");
    expect(body).toContain("# TYPE nimbus_index_items_total gauge");
    expect(body).toMatch(/nimbus_index_items_total\{service="github"\} 2/);
    expect(body).toMatch(/nimbus_index_items_total\{service="slack"\} 1/);
  });

  test("/metrics emits index size, embedding coverage, and latency quantile gauges", async () => {
    handle = startMetricsServer(() => db, 0);
    const body = await (await get(handle.port, "/metrics")).text();
    expect(body).toContain("# HELP nimbus_index_size_bytes");
    expect(body).toContain("# TYPE nimbus_index_size_bytes gauge");
    expect(body).toMatch(/nimbus_index_size_bytes \d+/);
    expect(body).toContain("# HELP nimbus_embedding_coverage_ratio");
    expect(body).toMatch(/nimbus_embedding_coverage_ratio [\d.]+/);
    expect(body).toContain("# HELP nimbus_query_latency_ms");
    expect(body).toMatch(/nimbus_query_latency_ms\{quantile="p50"\} \d+/);
    expect(body).toMatch(/nimbus_query_latency_ms\{quantile="p95"\} \d+/);
    expect(body).toMatch(/nimbus_query_latency_ms\{quantile="p99"\} \d+/);
  });

  test("/metrics emits connector_health_state gauges for known connectors", async () => {
    transitionHealth(db, "github", { type: "sync_success" });
    handle = startMetricsServer(() => db, 0);
    const body = await (await get(handle.port, "/metrics")).text();
    expect(body).toContain("# HELP nimbus_connector_health_state");
    expect(body).toContain("# TYPE nimbus_connector_health_state gauge");
    expect(body).toMatch(/nimbus_connector_health_state\{connector="github",state="\w+"\} 1/);
  });

  test("body ends with trailing newline (Prometheus expects one)", async () => {
    handle = startMetricsServer(() => db, 0);
    const body = await (await get(handle.port, "/metrics")).text();
    expect(body.endsWith("\n")).toBe(true);
  });

  test("escapes label backslash, double-quote, and newline characters", async () => {
    const escapeDb = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
    const now = Date.now();
    const rawLabel = String.raw`tricky"name\with`;
    const wild = `${rawLabel}\nnewline`;
    escapeDb.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at)
       VALUES (?, ?, 'doc', 'x', 't', ?, ?)`,
      ["w1", wild, now, now],
    );
    const localHandle = startMetricsServer(() => escapeDb, 0);
    try {
      const body = await (await get(localHandle.port, "/metrics")).text();
      expect(body).toContain(String.raw`service="tricky\"name\\with newline"`);
    } finally {
      localHandle.stop();
      escapeDb.close();
    }
  });

  test("getDb is called per request so reopens / handle swaps are picked up", async () => {
    let lookups = 0;
    handle = startMetricsServer(() => {
      lookups += 1;
      return db;
    }, 0);
    await get(handle.port, "/metrics");
    await get(handle.port, "/metrics");
    expect(lookups).toBe(2);
  });

  test("stop() returns without throwing after a successful request", async () => {
    handle = startMetricsServer(() => db, 0);
    expect((await get(handle.port, "/healthz")).status).toBe(200);
    expect(() => handle?.stop()).not.toThrow();
  });

  test("stop() is idempotent — calling twice does not throw", async () => {
    handle = startMetricsServer(() => db, 0);
    handle.stop();
    expect(() => handle?.stop()).not.toThrow();
    handle = null;
  });
});
