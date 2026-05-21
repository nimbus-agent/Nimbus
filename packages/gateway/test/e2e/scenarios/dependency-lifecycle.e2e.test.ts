/**
 * Phase 5 T2 PR 4 — dependency lifecycle end-to-end (in-process).
 *
 * Covers the full chain:
 *   1. Install A@1.5.0 (root, no deps)          → extension row created
 *   2. Install B@1.0.0 (depends on A ^1.0.0)    → dep edges recorded
 *   3. Install C@1.0.0 (depends on A ^2.0.0)    → DependencyConflictError thrown; C absent
 *   4. Remove A without --force                  → AutomationRpcError (reverse_dep_blocked)
 *   5. Remove A with --force                     → A gone; dep edges cleared; B row intact
 *   6. verifyExtensionsBestEffort                → B marked dependency_missing (A absent)
 *   7. Re-install A; verifyExtensionsBestEffort  → B cleared from missingDependencyRegistry
 *
 * Uses the in-process pattern (no Gateway subprocess) per the project e2e
 * convention. Helpers are inlined — there is no shared `test/e2e/helpers/`
 * directory in this codebase.
 */

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

// ── Inline helpers ────────────────────────────────────────────────────────────

/**
 * Create a minimal unsigned extension directory under `baseDir/<id>/`.
 * Returns the path to the created directory.
 *
 * Unsigned extensions are accepted by installExtensionFromLocalDirectory when
 * no `publisher` field is present in the manifest — the I16 publisher-key
 * verification branch only fires when the manifest carries a publisher block.
 */
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

/**
 * Minimal silent logger — matches the `Logger` shape that
 * `verifyExtensionsBestEffort` requires without importing pino in tests.
 */
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

// ── Test suite ────────────────────────────────────────────────────────────────

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
    // extensionsDir is created by setupFreshExtensionDb inside tmpdir — clean up.
    try {
      rmSync(extensionsDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  test("install + conflict refusal + --force remove + startup-disable + reinstall clears", async () => {
    // ── Step 1: Install A@1.5.0 (root, no deps) ────────────────────────────
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

    // ── Step 2: Install B@1.0.0 (depends on A ^1.0.0) ─────────────────────
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

    // Forward edges: B → A
    const fwdB = forwardDeps(db, "com.example.B");
    expect(fwdB.length).toBe(1);
    expect(fwdB[0]).toEqual({ id: "com.shared.A", range: "^1.0.0" });

    // Reverse edges: A ← B
    const revA = reverseDeps(db, "com.shared.A");
    expect(revA.length).toBe(1);
    expect(revA[0]).toEqual({ extensionId: "com.example.B", range: "^1.0.0" });

    // ── Step 3: Install C@1.0.0 (depends on A ^2.0.0) → should conflict ───
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

    // Must throw a DependencyConflictError
    expect(isDependencyConflictError(caughtError)).toBe(true);

    // C must NOT have been persisted
    const cRow = listExtensions(db).find((r) => r.id === "com.example.C");
    expect(cRow).toBeUndefined();

    // C's directory must NOT exist on disk
    const cInstallPath = join(extensionsDir, "com.example.C");
    expect(existsSync(cInstallPath)).toBe(false);

    // ── Step 4: Remove A WITHOUT --force → should be blocked ────────────────
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

    // Must have thrown (AutomationRpcError with reverse_dep_blocked message)
    expect(removeBlockedError).toBeInstanceOf(AutomationRpcError);
    if (removeBlockedError instanceof AutomationRpcError) {
      expect(removeBlockedError.message).toContain("reverse_dep_blocked");
    }

    // A must still be installed
    const aStillRow = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aStillRow).toBeDefined();

    // ── Step 5: Remove A WITH --force → should succeed ──────────────────────
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

    // A row must be gone
    const aGoneRow = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aGoneRow).toBeUndefined();

    // A's forward dep edges must be cleared
    const fwdAAfterRemove = forwardDeps(db, "com.shared.A");
    expect(fwdAAfterRemove).toEqual([]);

    // B row must still be present (removing A doesn't touch B)
    const bStillRow = listExtensions(db).find((r) => r.id === "com.example.B");
    expect(bStillRow).toBeDefined();

    // ── Step 6: verifyExtensionsBestEffort → B marked dependency_missing ────
    _resetMissingDependencyRegistry();
    await verifyExtensionsBestEffort(db, logger);

    expect(missingDependencyRegistry.has("com.example.B")).toBe(true);
    const reason = missingDependencyRegistry.reasonFor("com.example.B");
    expect(reason?.reason).toBe("dependency_missing");
    expect(reason?.missingDepId).toBe("com.shared.A");

    // ── Step 7: Re-install A; verify pass clears B ──────────────────────────
    // Fresh temp dir for the rebuilt source (buildExtensionDir wants the base
    // dir to already exist; mkdtempSync provides that atomically).
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

    // Confirm A is back
    const aReinstalled = listExtensions(db).find((r) => r.id === "com.shared.A");
    expect(aReinstalled).toBeDefined();

    // Reset the registry (mirrors what production does at the top of each startup pass).
    _resetMissingDependencyRegistry();
    await verifyExtensionsBestEffort(db, logger);

    // B must NO LONGER be marked as dependency_missing
    expect(missingDependencyRegistry.has("com.example.B")).toBe(false);
  }, 60_000);
});
