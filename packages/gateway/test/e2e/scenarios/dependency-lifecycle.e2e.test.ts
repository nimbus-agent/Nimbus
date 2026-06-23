import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import { listExtensions } from "../../../src/automation/extension-store.ts";
import { isDependencyConflictError } from "../../../src/extensions/dependency-errors.ts";
import { forwardDeps, reverseDeps } from "../../../src/extensions/dependency-store.ts";
import { installExtensionFromLocalDirectory } from "../../../src/extensions/install-from-local.ts";
import {
  _resetMissingDependencyRegistry,
  missingDependencyRegistry,
} from "../../../src/extensions/missing-dependency-registry.ts";
import { verifyExtensionsBestEffort } from "../../../src/extensions/verify-extensions.ts";
import { AutomationRpcError, dispatchAutomationRpc } from "../../../src/ipc/automation-rpc.ts";
import { setupFreshExtensionDb } from "../../fixtures/extension.ts";

function buildExtensionDir(opts: {
  baseDir: string;
  id: string;
  version: string;
  dependsOn?: Record<string, string>;
}): string {
  const dir = join(opts.baseDir, opts.id);
  mkdirSync(join(dir, "dist"), { recursive: true });
  const manifest: Record<string, unknown> = {
    id: opts.id,
    version: opts.version,
    permissions: { network: [], filesystem: { read: [], write: [] } },
  };
  if (opts.dependsOn !== undefined) {
    manifest["dependsOn"] = opts.dependsOn;
  }
  writeFileSync(join(dir, "nimbus.extension.json"), JSON.stringify(manifest), "utf8");
  writeFileSync(
    join(dir, "dist", "index.js"),
    `/* extension ${opts.id}@${opts.version} */`,
    "utf8",
  );
  return dir;
}

function silentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => silentLogger(),
    level: "silent",
  } as unknown as Logger;
}

describe("T2 PR 4 — dependency lifecycle (end-to-end in-process)", () => {
  let workDir: string;
  let sourceDir: string;
  let extensionsDir: string;
  let db: ReturnType<typeof setupFreshExtensionDb>["db"];
  const logger = silentLogger();

  beforeEach(() => {
    const fresh = setupFreshExtensionDb();
    db = fresh.db;
    extensionsDir = fresh.extensionsDir;
    workDir = mkdtempSync(join(tmpdir(), "nimbus-dep-lifecycle-e2e-"));
    sourceDir = join(workDir, "sources");
    mkdirSync(sourceDir, { recursive: true });
    _resetMissingDependencyRegistry();
  });

  afterEach(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
    try {
      rmSync(extensionsDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("install + conflict refusal + --force remove + startup-disable + reinstall clears", async () => {
    const aSourceDir = buildExtensionDir({
      baseDir: sourceDir,
      id: "com.shared.A",
      version: "1.5.0",
    });
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: aSourceDir,
    });

    const allAfterA = listExtensions(db);
    const aRow = allAfterA.find((r) => r.id === "com.shared.A");
    expect(aRow).toBeDefined();
    expect(aRow?.version).toBe("1.5.0");

    const bSourceDir = buildExtensionDir({
      baseDir: sourceDir,
      id: "com.example.B",
      version: "1.0.0",
      dependsOn: { "com.shared.A": "^1.0.0" },
    });
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: bSourceDir,
    });

    const bRow = listExtensions(db).find((r) => r.id === "com.example.B");
    expect(bRow).toBeDefined();

    const fwdB = forwardDeps(db, "com.example.B");
    expect(fwdB).toHaveLength(1);
    expect(fwdB[0]).toEqual({ id: "com.shared.A", range: "^1.0.0" });

    const revA = reverseDeps(db, "com.shared.A");
    expect(revA).toHaveLength(1);
    expect(revA[0]).toEqual({ extensionId: "com.example.B", range: "^1.0.0" });

    const cSourceDir = buildExtensionDir({
      baseDir: sourceDir,
      id: "com.example.C",
      version: "1.0.0",
      dependsOn: { "com.shared.A": "^2.0.0" },
    });

    let caughtError: unknown;
    try {
      await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: cSourceDir,
      });
    } catch (e) {
      caughtError = e;
    }

    expect(isDependencyConflictError(caughtError)).toBe(true);

    const cRow = listExtensions(db).find((r) => r.id === "com.example.C");
    expect(cRow).toBeUndefined();

    const cInstallPath = join(extensionsDir, "com.example.C");
    expect(existsSync(cInstallPath)).toBe(false);

    let removeBlockedError: unknown;
    try {
      await dispatchAutomationRpc({
        method: "extension.remove",
        params: { id: "com.shared.A" },
        db,
        extensionsDir,
      });
    } catch (e) {
      removeBlockedError = e;
    }

    expect(removeBlockedError).toBeInstanceOf(AutomationRpcError);
    if (removeBlockedError instanceof AutomationRpcError) {
      expect(removeBlockedError.message).toContain("reverse_dep_blocked");
    }

    const aStillRow = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aStillRow).toBeDefined();

    const forceResult = await dispatchAutomationRpc({
      method: "extension.remove",
      params: { id: "com.shared.A", force: true },
      db,
      extensionsDir,
    });

    expect(forceResult.kind).toBe("hit");
    if (forceResult.kind === "hit") {
      expect((forceResult.value as Record<string, unknown>)["ok"]).toBe(true);
    }

    const aGoneRow = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aGoneRow).toBeUndefined();

    const fwdAAfterRemove = forwardDeps(db, "com.shared.A");
    expect(fwdAAfterRemove).toEqual([]);

    const bStillRow = listExtensions(db).find((r) => r.id === "com.example.B");
    expect(bStillRow).toBeDefined();

    _resetMissingDependencyRegistry();
    await verifyExtensionsBestEffort(db, logger);

    expect(missingDependencyRegistry.has("com.example.B")).toBe(true);
    const reason = missingDependencyRegistry.reasonFor("com.example.B");
    expect(reason?.reason).toBe("dependency_missing");
    expect(reason?.missingDepId).toBe("com.shared.A");

    const aSource2DirActual = buildExtensionDir({
      baseDir: mkdtempSync(join(tmpdir(), "nimbus-dep-lc-a2-")),
      id: "com.shared.A",
      version: "1.5.0",
    });

    await installExtensionFromLocalDirectory({
      db,
      extensionsDir,
      sourcePath: aSource2DirActual,
    });

    const aReinstalled = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aReinstalled).toBeDefined();

    _resetMissingDependencyRegistry();
    await verifyExtensionsBestEffort(db, logger);

    expect(missingDependencyRegistry.has("com.example.B")).toBe(false);
  }, 60_000);
});
