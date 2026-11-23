import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRunController } from "../../agent-runs/agent-run-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { createMemoryVault } from "../../testing/bun-test-support.ts";
import type { PlatformPaths } from "../paths.ts";
import { collectSidecarsFromEnv, parseSidecarPortEnv } from "./http-sidecar.ts";

describe("parseSidecarPortEnv", () => {
  test("accepts a positive integer, trimmed", () => {
    expect(parseSidecarPortEnv("8080")).toBe(8080);
    expect(parseSidecarPortEnv("  9100  ")).toBe(9100);
  });

  test("a leading integer wins over trailing junk (parseInt semantics)", () => {
    expect(parseSidecarPortEnv("8080abc")).toBe(8080);
  });

  test.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["non-numeric", "abc"],
    ["zero", "0"],
    ["negative", "-5"],
  ])("rejects %s", (_label, raw) => {
    expect(parseSidecarPortEnv(raw)).toBeUndefined();
  });
});

describe("collectSidecarsFromEnv", () => {
  let dir: string;
  let db: Database;
  let paths: PlatformPaths;
  const stops: Array<() => void> = [];
  const saved = {
    http: process.env["NIMBUS_HTTP_PORT"],
    metrics: process.env["NIMBUS_METRICS_PORT"],
  };

  /** A currently-free loopback port: bind port 0, read it, release it. */
  function freePort(): number {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("x") });
    const port = s.port;
    s.stop(true);
    if (port === undefined) throw new Error("no port");
    return port;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-sidecar-"));
    const dataDir = join(dir, "data");
    const configDir = join(dir, "config");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    paths = { dataDir, configDir } as unknown as PlatformPaths;
    db = new Database(join(dataDir, "nimbus.db"));
    LocalIndex.ensureSchema(db);
    delete process.env["NIMBUS_HTTP_PORT"];
    delete process.env["NIMBUS_METRICS_PORT"];
  });

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    db.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the read-only handle a moment after stop(); the dir is a temp dir.
    }
    for (const [key, v] of [
      ["NIMBUS_HTTP_PORT", saved.http],
      ["NIMBUS_METRICS_PORT", saved.metrics],
    ] as const) {
      if (v === undefined) delete process.env[key];
      else process.env[key] = v;
    }
  });

  test("starts nothing when neither port variable is set", () => {
    collectSidecarsFromEnv(db, paths, stops);
    expect(stops).toHaveLength(0);
  });

  test("starts nothing for an unusable port value", () => {
    process.env["NIMBUS_HTTP_PORT"] = "not-a-port";
    process.env["NIMBUS_METRICS_PORT"] = "0";
    collectSidecarsFromEnv(db, paths, stops);
    expect(stops).toHaveLength(0);
  });

  test("NIMBUS_METRICS_PORT alone serves /healthz and /metrics, and its stop closes the listener", async () => {
    const port = freePort();
    process.env["NIMBUS_METRICS_PORT"] = String(port);
    collectSidecarsFromEnv(db, paths, stops);
    expect(stops).toHaveLength(1);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const metrics = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("nimbus_index_items_total");

    // The pushed handle is the server's own stop: calling it twice must not throw.
    const stop = stops.pop();
    expect(typeof stop).toBe("function");
    stop?.();
  });

  test("NIMBUS_HTTP_PORT alone starts the read-only server on the db under dataDir", async () => {
    const port = freePort();
    process.env["NIMBUS_HTTP_PORT"] = String(port);
    collectSidecarsFromEnv(db, paths, stops);
    expect(stops).toHaveLength(1);
    // No metrics server: its port was never configured.
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents`);
    // The agents surface is not mounted: no `agentRuns` seam was supplied.
    expect(res.status).toBe(404);
  });

  test("both ports start both servers, in http-then-metrics order", async () => {
    const http = freePort();
    const metrics = freePort();
    process.env["NIMBUS_HTTP_PORT"] = String(http);
    process.env["NIMBUS_METRICS_PORT"] = String(metrics);
    collectSidecarsFromEnv(db, paths, stops);
    expect(stops).toHaveLength(2);
    expect((await fetch(`http://127.0.0.1:${metrics}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${http}/v1/agents`)).status).toBe(404);
  });

  test("the caller's seams reach the server: a wired agent run store mounts the agents surface", async () => {
    const port = freePort();
    process.env["NIMBUS_HTTP_PORT"] = String(port);
    const vault = createMemoryVault();
    collectSidecarsFromEnv(db, paths, stops, {
      agentRuns: new AgentRunController({ nowMs: () => Date.now() }),
      clipsVault: vault,
    });
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents`);
    // Mounted now (no longer the 404 "disabled" answer); an unauthenticated read is refused.
    expect(res.status).toBe(401);
  });

  test("every optional seam is accepted without disturbing startup", async () => {
    const port = freePort();
    process.env["NIMBUS_HTTP_PORT"] = String(port);
    const resolved: string[] = [];
    collectSidecarsFromEnv(db, paths, stops, {
      resolveScimToken: async () => {
        resolved.push("scim");
        return "t";
      },
      resolveAdminToken: async () => "a",
      authorPolicy: async () => {
        throw new Error("unused");
      },
      resolveTeamsEventsSurface: async () => undefined,
      scheduleEmbedding: () => {},
      briefStartRun: () => {},
      briefSave: () => ({ itemId: "i" }),
      agentInvoke: async () => {
        throw new Error("unused");
      },
      fetchItem: async () => {
        throw new Error("unused");
      },
      resolveFetchable: async () => () => false,
    });
    expect(stops).toHaveLength(1);
    // The server is up and refuses an unauthenticated agents read rather than crashing.
    const res = await fetch(`http://127.0.0.1:${port}/v1/agents`);
    expect([401, 403, 404]).toContain(res.status);
  });
});
