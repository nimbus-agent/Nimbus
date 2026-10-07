/**
 * The mesh owns a user MCP's sandbox leaf (`<sandboxDir>/user_<serviceId>`): it names the
 * directories no user MCP may be granted, and it removes the leaf when the connector is removed —
 * best-effort, because a Windows child releases its cwd handle a moment after it exits and
 * `connector.remove` must not fail on a locked directory.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformPaths } from "../../platform/paths.ts";
import { sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import { createMockVault } from "../../vault/mock.ts";
import { LazyConnectorMesh } from "./mesh.ts";

const roots: string[] = [];
const meshes: LazyConnectorMesh[] = [];

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-sbx-"));
  roots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
  };
}

afterEach(async () => {
  for (const m of meshes.splice(0)) await m.disconnect();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe("LazyConnectorMesh — user MCP sandbox", () => {
  test("userMcpProtectedRoots names data, config and the sandbox root", () => {
    const paths = makePaths();
    const mesh = new LazyConnectorMesh(paths, createMockVault());
    meshes.push(mesh);
    expect(mesh.userMcpProtectedRoots()).toEqual([
      paths.dataDir,
      paths.configDir,
      paths.sandboxDir,
    ]);
  });

  test("removeUserMcpSandbox deletes this service's leaf and nothing beside it", async () => {
    const paths = makePaths();
    const mesh = new LazyConnectorMesh(paths, createMockVault());
    meshes.push(mesh);
    const leaf = sandboxCwdFor(paths.sandboxDir, "user.mcp_notes");
    const sibling = sandboxCwdFor(paths.sandboxDir, "user.mcp_other");
    mkdirSync(join(leaf, "nested"), { recursive: true });
    mkdirSync(sibling, { recursive: true });

    await mesh.removeUserMcpSandbox("mcp_notes");

    expect(existsSync(leaf)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test("a directory that will not delete is retried 3 times, logged, and never thrown", async () => {
    const paths = makePaths();
    const warnings: Array<{ bindings: Record<string, unknown>; msg: string | undefined }> = [];
    const attempts: string[] = [];
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      logger: { warn: (bindings, msg) => warnings.push({ bindings, msg }) },
      removeSandboxDir: (p) => {
        attempts.push(p);
        throw new Error("EBUSY: resource busy or locked");
      },
    });
    meshes.push(mesh);

    const started = performance.now();
    await mesh.removeUserMcpSandbox("mcp_locked");
    const elapsed = performance.now() - started;

    const leaf = sandboxCwdFor(paths.sandboxDir, "user.mcp_locked");
    expect(attempts).toEqual([leaf, leaf, leaf]);
    expect(elapsed).toBeGreaterThanOrEqual(190); // two 100 ms pauses between three attempts
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe("user MCP sandbox directory not removed");
    expect(warnings[0]?.bindings["serviceId"]).toBe("mcp_locked");
  });

  test("a delete that succeeds on the second attempt logs nothing", async () => {
    const paths = makePaths();
    const warnings: unknown[] = [];
    let n = 0;
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      logger: { warn: (b) => warnings.push(b) },
      removeSandboxDir: () => {
        n += 1;
        if (n === 1) throw new Error("EBUSY");
      },
    });
    meshes.push(mesh);
    await mesh.removeUserMcpSandbox("mcp_flaky");
    expect(n).toBe(2);
    expect(warnings).toEqual([]);
  });
});

describe("LazyConnectorMesh — ensureUserMcpSandboxClean (re-registration)", () => {
  test("no leaf: true, and nothing is deleted", async () => {
    const paths = makePaths();
    const deleted: string[] = [];
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      removeSandboxDir: (p) => deleted.push(p),
    });
    meshes.push(mesh);
    expect(await mesh.ensureUserMcpSandboxClean("mcp_new")).toBe(true);
    expect(deleted).toEqual([]);
  });

  test("a stale leaf holding a file is deleted, and nothing beside it", async () => {
    const paths = makePaths();
    const mesh = new LazyConnectorMesh(paths, createMockVault());
    meshes.push(mesh);
    const leaf = mesh.userMcpSandboxLeaf("mcp_reused");
    expect(leaf).toBe(sandboxCwdFor(paths.sandboxDir, "user.mcp_reused"));
    const sibling = sandboxCwdFor(paths.sandboxDir, "user.mcp_other");
    mkdirSync(join(leaf, "nested"), { recursive: true });
    writeFileSync(join(leaf, "nested", "secret.txt"), "left behind");
    mkdirSync(sibling, { recursive: true });

    expect(await mesh.ensureUserMcpSandboxClean("mcp_reused")).toBe(true);
    expect(existsSync(leaf)).toBe(false);
    expect(existsSync(sibling)).toBe(true);
  });

  test("an undeletable leaf: 3 attempts, logged, false — and never thrown", async () => {
    const paths = makePaths();
    const warnings: Array<{ bindings: Record<string, unknown>; msg: string | undefined }> = [];
    const attempts: string[] = [];
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      logger: { warn: (bindings, msg) => warnings.push({ bindings, msg }) },
      sandboxDirExists: () => true,
      removeSandboxDir: (p) => {
        attempts.push(p);
        throw new Error("EBUSY: resource busy or locked");
      },
    });
    meshes.push(mesh);
    expect(await mesh.ensureUserMcpSandboxClean("mcp_locked")).toBe(false);
    const leaf = sandboxCwdFor(paths.sandboxDir, "user.mcp_locked");
    expect(attempts).toEqual([leaf, leaf, leaf]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toBe(
      "stale user MCP sandbox directory not cleared before registration",
    );
    expect(warnings[0]?.bindings["serviceId"]).toBe("mcp_locked");
  });

  test("a delete that reports success but leaves the leaf in place is still false", async () => {
    const paths = makePaths();
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      logger: { warn: () => {} },
      sandboxDirExists: () => true,
      removeSandboxDir: () => {},
    });
    meshes.push(mesh);
    expect(await mesh.ensureUserMcpSandboxClean("mcp_stuck")).toBe(false);
  });

  test("a delete that succeeds on the second attempt is true", async () => {
    const paths = makePaths();
    let present = true;
    let n = 0;
    const mesh = new LazyConnectorMesh(paths, createMockVault(), {
      sandboxDirExists: () => present,
      removeSandboxDir: () => {
        n += 1;
        if (n === 1) throw new Error("EBUSY");
        present = false;
      },
    });
    meshes.push(mesh);
    expect(await mesh.ensureUserMcpSandboxClean("mcp_flaky")).toBe(true);
    expect(n).toBe(2);
  });
});
