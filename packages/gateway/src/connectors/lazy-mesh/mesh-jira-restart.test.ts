/**
 * C3: the Jira child gets its token, e-mail, base URL and cloud id from the environment it is
 * spawned with, so every successful `connector.auth jira` has to retire the running slot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";

let base: string | undefined;
let mesh: LazyConnectorMesh | undefined;

afterEach(async () => {
  await mesh?.disconnect();
  mesh = undefined;
  if (base !== undefined) rmSync(base, { recursive: true, force: true });
  base = undefined;
});

function makePaths(dir: string): PlatformPaths {
  return {
    configDir: join(dir, "nimbus", "config"),
    dataDir: join(dir, "nimbus", "data"),
    logDir: join(dir, "nimbus", "log"),
    socketPath: join(dir, "nimbus", "sock"),
    extensionsDir: join(dir, "nimbus", "ext"),
    tempDir: join(dir, "nimbus", "tmp"),
    sandboxDir: join(dir, "nimbus", "sandbox"),
  };
}

type Slots = { lazySlots: Map<string, unknown> };

describe("restartJira", () => {
  test("retires the running slot and bumps its generation so the next use respawns", async () => {
    base = mkdtempSync(join(tmpdir(), "nimbus-jira-restart-"));
    const m = new LazyConnectorMesh(makePaths(base), createMockVault(), {});
    mesh = m;
    let disconnected = false;
    const internals = m as unknown as Slots;
    internals.lazySlots.set(LAZY_MESH.jira, {
      client: {
        listTools: () => Promise.resolve({}),
        disconnect: () => {
          disconnected = true;
          return Promise.resolve();
        },
      } as unknown as MCPClient,
      idleTimer: undefined,
      drain: new LazyDrainTracker(),
    });
    const epoch = m.getToolsEpoch();
    m.restartJira();
    expect(internals.lazySlots.has(LAZY_MESH.jira)).toBe(false);
    expect(m.getToolsEpoch()).toBeGreaterThan(epoch);
    for (let i = 0; i < 10 && !disconnected; i++) await Promise.resolve();
    expect(disconnected).toBe(true);
  });

  test("with no running slot it does nothing", () => {
    base = mkdtempSync(join(tmpdir(), "nimbus-jira-restart-"));
    const m = new LazyConnectorMesh(makePaths(base), createMockVault(), {});
    mesh = m;
    const epoch = m.getToolsEpoch();
    m.restartJira();
    expect(m.getToolsEpoch()).toBe(epoch);
  });
});
