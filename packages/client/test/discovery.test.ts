import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSocketPath, readGatewayState } from "../src/discovery.ts";
import type { NimbusPaths } from "../src/paths.ts";

function makeTempPaths(): NimbusPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-discovery-"));
  return {
    configDir: root,
    dataDir: root,
    logDir: join(root, "logs"),
    socketPath: join(root, "default.sock"),
    extensionsDir: join(root, "ext"),
  };
}

describe("readGatewayState", () => {
  test("returns undefined when state file missing", async () => {
    const paths = makeTempPaths();
    const r = await readGatewayState(paths);
    expect(r).toBeUndefined();
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("parses valid state file", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      join(paths.dataDir, "gateway.json"),
      JSON.stringify({ pid: 1234, socketPath: "/run/sock", logPath: "/log" }),
    );
    const r = await readGatewayState(paths);
    expect(r?.pid).toBe(1234);
    expect(r?.socketPath).toBe("/run/sock");
    expect(r?.logPath).toBe("/log");
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("returns undefined for malformed JSON", async () => {
    const paths = makeTempPaths();
    writeFileSync(join(paths.dataDir, "gateway.json"), "{ not json");
    const r = await readGatewayState(paths);
    expect(r).toBeUndefined();
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("returns undefined for wrong schema", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      join(paths.dataDir, "gateway.json"),
      JSON.stringify({ pid: "not-number", socketPath: "/run/sock" }),
    );
    const r = await readGatewayState(paths);
    expect(r).toBeUndefined();
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("returns undefined when socketPath is empty string", async () => {
    const paths = makeTempPaths();
    writeFileSync(join(paths.dataDir, "gateway.json"), JSON.stringify({ pid: 1, socketPath: "" }));
    const r = await readGatewayState(paths);
    expect(r).toBeUndefined();
    rmSync(paths.dataDir, { recursive: true, force: true });
  });
});

describe("discoverSocketPath precedence", () => {
  test("override wins over state file and default", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      join(paths.dataDir, "gateway.json"),
      JSON.stringify({ pid: 1, socketPath: "/state/sock" }),
    );
    const r = await discoverSocketPath({ override: "/forced/sock", paths });
    expect(r.source).toBe("override");
    expect(r.socketPath).toBe("/forced/sock");
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("state file wins over default", async () => {
    const paths = makeTempPaths();
    writeFileSync(
      join(paths.dataDir, "gateway.json"),
      JSON.stringify({ pid: 7, socketPath: "/state/sock" }),
    );
    const r = await discoverSocketPath({ paths });
    expect(r.source).toBe("stateFile");
    expect(r.socketPath).toBe("/state/sock");
    expect(r.pid).toBe(7);
    rmSync(paths.dataDir, { recursive: true, force: true });
  });

  test("falls back to default when no state file", async () => {
    const paths = makeTempPaths();
    const r = await discoverSocketPath({ paths });
    expect(r.source).toBe("default");
    expect(r.socketPath).toBe(paths.socketPath);
    rmSync(paths.dataDir, { recursive: true, force: true });
  });
});
