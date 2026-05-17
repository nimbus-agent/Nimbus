/**
 * Unit tests for `LazyConnectorMesh` — the lazy MCP mesh that spawns
 * per-connector child processes. The class is constructed against a real
 * `MockVault` + a tmp-dir-backed `PlatformPaths`; tests exercise:
 *
 *   - the constructor (filesystem MCPClient wiring, spawn context)
 *   - the simple getters (`getToolsEpoch`)
 *   - every `ensure<Service>Running` delegator (no vault keys present →
 *     each delegate is a no-op, but the wrapper line is still covered)
 *   - `disconnect()` with no active slots
 *   - `stopExtensionClient` against an unknown extension id (no-op)
 *
 * We intentionally do NOT exercise actual MCP child spawning here — that
 * path requires real `bunx` resolution and would launch real subprocesses.
 * Slot-state plumbing is covered by `lazy-mesh.test.ts` (LazyDrainTracker
 * + mergeToolMapsOrThrow). This file targets the wiring boilerplate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { createLazyConnectorMesh, LazyConnectorMesh } from "./mesh.ts";

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-"));
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
  };
}

let mesh: LazyConnectorMesh | undefined;

beforeEach(() => {
  mesh = undefined;
});

afterEach(async () => {
  if (mesh !== undefined) {
    try {
      await mesh.disconnect();
    } catch {
      /* ignore */
    }
    mesh = undefined;
  }
});

describe("LazyConnectorMesh constructor", () => {
  test("constructs without throwing using only vault + paths", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh).toBeInstanceOf(LazyConnectorMesh);
  });

  test("getToolsEpoch starts at 0", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh.getToolsEpoch()).toBe(0);
  });

  test("accepts optional inactivityMs + listUserMcpConnectors", () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      inactivityMs: 60_000,
      listUserMcpConnectors: () => [],
    });
    expect(mesh.getToolsEpoch()).toBe(0);
  });

  test("accepts optional auditDb + logger + obsidianVaultPaths", () => {
    const noopLogger = { warn: () => {} };
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      logger: noopLogger,
      obsidianVaultPaths: [],
    });
    expect(mesh.getToolsEpoch()).toBe(0);
  });
});

describe("createLazyConnectorMesh", () => {
  test("returns a LazyConnectorMesh instance", async () => {
    mesh = await createLazyConnectorMesh(makePaths(), createMockVault());
    expect(mesh).toBeInstanceOf(LazyConnectorMesh);
  });
});

describe("ensure<Service>Running delegators (no vault keys → all no-op)", () => {
  // Each ensure*Running wraps a free `ensureXxxMcp` function. With no vault
  // keys + no MCP spawn path triggered, each one returns without effect.
  // The point here is line coverage of the delegator wrapper itself.
  beforeEach(() => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
  });

  test("ensurePhase3BundleRunning is a no-op without vault keys", async () => {
    await mesh!.ensurePhase3BundleRunning();
  });
  test("ensureGoogleDriveRunning", async () => {
    await mesh!.ensureGoogleDriveRunning();
  });
  // ensureMicrosoftBundleRunning spawns onedrive/outlook/teams unconditionally
  // — skip in unit tests; covered by E2E.
  test("ensureGithubRunning", async () => {
    await mesh!.ensureGithubRunning();
  });
  test("ensureGitlabRunning", async () => {
    await mesh!.ensureGitlabRunning();
  });
  test("ensureBitbucketRunning", async () => {
    await mesh!.ensureBitbucketRunning();
  });
  test("ensureSlackRunning", async () => {
    await mesh!.ensureSlackRunning();
  });
  test("ensureLinearRunning", async () => {
    await mesh!.ensureLinearRunning();
  });
  test("ensureJiraRunning", async () => {
    await mesh!.ensureJiraRunning();
  });
  test("ensureNotionRunning", async () => {
    await mesh!.ensureNotionRunning();
  });
  test("ensureObsidianRunning", async () => {
    await mesh!.ensureObsidianRunning();
  });
  test("ensureConfluenceRunning", async () => {
    await mesh!.ensureConfluenceRunning();
  });
  test("ensureDiscordRunning", async () => {
    await mesh!.ensureDiscordRunning();
  });
  test("ensureJenkinsRunning", async () => {
    await mesh!.ensureJenkinsRunning();
  });
  test("ensureCircleciRunning", async () => {
    await mesh!.ensureCircleciRunning();
  });
  test("ensurePagerdutyRunning", async () => {
    await mesh!.ensurePagerdutyRunning();
  });
  test("ensureKubernetesRunning", async () => {
    await mesh!.ensureKubernetesRunning();
  });
});

describe("user-mcp + extension lifecycle (no rows)", () => {
  test("ensureUserMcpRunning is a no-op when service id has no row", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault(), {
      listUserMcpConnectors: () => [],
    });
    // No connectors → returns silently.
    await mesh.ensureUserMcpRunning("nonexistent");
  });

  test("stopExtensionClient on unknown id is a no-op", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await mesh.stopExtensionClient("unknown.ext");
  });
});

describe("disconnect with no active slots", () => {
  test("disconnect after construction tears down filesystem MCP cleanly", async () => {
    mesh = new LazyConnectorMesh(makePaths(), createMockVault());
    await mesh.disconnect();
    // After disconnect, calling again should also not throw (lazySlots is
    // empty so the loop is empty and filesystem.disconnect catches errors).
    await mesh.disconnect();
    // Mark as already disconnected so afterEach doesn't re-disconnect.
    mesh = undefined;
  });
});

// listToolsForDispatcher + listTools require a working filesystem MCP child
// process which is OS-spawned via `bunx`. Skipped here; covered by E2E.
