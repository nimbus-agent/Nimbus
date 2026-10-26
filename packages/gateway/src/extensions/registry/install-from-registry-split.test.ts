/**
 * `fetchVerifiedRegistryPackage` / `installVerifiedRegistryPackage`: the two halves of
 * `installFromRegistry`. The fetch half verifies and stages; every install side effect belongs to
 * the install half. (The error codes and their order are pinned by `install-from-registry.test.ts`.)
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import type { ExtensionInstallApprovalRequest } from "../install-from-local.ts";
import { readPublisherKey } from "../publisher-keys.ts";
import { buildTestRegistry, type TestRegistry } from "./__fixtures__/build-test-registry.ts";
import {
  fetchVerifiedRegistryPackage,
  type InstallFromRegistryDeps,
  installVerifiedRegistryPackage,
} from "./install-from-registry.ts";
import {
  deleteRegistry,
  getExtensionSource,
  getRegistry,
  insertRegistry,
} from "./registry-store.ts";

const ID = "com.example.tool";
const NOW = Date.parse("2026-10-18T12:00:00Z");

let db: Database;
let tmp: string;
let extensionsDir: string;
let stage: string;
let vault: MockVault;
let reg: TestRegistry;
let asked: ExtensionInstallApprovalRequest[];

beforeEach(async () => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 76);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-instreg-split-"));
  extensionsDir = join(tmp, "extensions");
  stage = join(tmp, "stage");
  vault = new MockVault();
  asked = [];
  reg = await buildTestRegistry(join(tmp, "registry"), {
    id: ID,
    versions: [{ version: "1.0.0" }],
  });
  insertRegistry(db, {
    name: "main",
    url: join(tmp, "registry"),
    rootKey: reg.rootKey,
    rootFingerprint: publisherKeyFingerprint(reg.rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: NOW,
    lastIndexSha256: null,
  });
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

function deps(): InstallFromRegistryDeps {
  return {
    db,
    extensionsDir,
    vault,
    fetch: {
      fetchFn: () => Promise.reject(new Error("unexpected network")),
      enforceAirGap: () => false,
      now: () => NOW,
      production: false,
      // Neutral test default: never reach the real official registry host.
      builtin: null,
    },
    approve: async (r: ExtensionInstallApprovalRequest) => {
      asked.push(r);
      return true;
    },
  };
}

function auditRows(): number {
  return (db.query("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n;
}

describe("fetchVerifiedRegistryPackage", () => {
  test("fetchVerifiedRegistryPackage writes no extension row, vault key or audit row", async () => {
    const auditBefore = auditRows();
    const pkg = await fetchVerifiedRegistryPackage(deps(), { id: ID }, stage);
    expect(listExtensions(db)).toHaveLength(0);
    expect(await readPublisherKey(vault, "acme")).toBeUndefined();
    expect(auditRows()).toBe(auditBefore);
    expect(getExtensionSource(db, ID)).toBeUndefined();
    expect(asked).toHaveLength(0);
    expect(existsSync(extensionsDir)).toBe(false);
    // The verified tree is staged inside intoDir, not in the install tree.
    expect(pkg.sourceRoot.startsWith(stage)).toBe(true);
    expect(existsSync(join(pkg.sourceRoot, "dist", "index.js"))).toBe(true);
    expect(pkg.reg.name).toBe("main");
    expect(pkg.id).toBe(ID);
    expect(pkg.version).toBe("1.0.0");
  });

  test("the returned fingerprint and entry hash equal what an install records", async () => {
    const pkg = await fetchVerifiedRegistryPackage(deps(), { id: ID }, stage);
    expect(pkg.rootFingerprint).toBe(publisherKeyFingerprint(reg.rootKey));
    expect(pkg.entryHash).toBe(reg.entryHashOf("1.0.0"));
    const out = await installVerifiedRegistryPackage(deps(), pkg, "stable");
    expect(out.rootFingerprint).toBe(pkg.rootFingerprint);
    expect(out.entryHash).toBe(pkg.entryHash);
    expect(out.publisher.fingerprint).toBe(publisherKeyFingerprint(reg.publisherKey));
    expect(getExtensionSource(db, ID)).toEqual({
      registry: "main",
      rootFingerprint: pkg.rootFingerprint,
      channel: "stable",
    });
    expect(listExtensions(db).map((r) => r.id)).toEqual([ID]);
    expect(await readPublisherKey(vault, "acme")).toBeDefined();
    expect(auditRows()).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
  });

  test("it does advance the registry's anti-rollback sequence (a fetch write, by design)", async () => {
    await fetchVerifiedRegistryPackage(deps(), { id: ID }, stage);
    expect(getRegistry(db, "main")?.lastSequence).toBeGreaterThan(0);
  });

  test("a non-empty intoDir is refused before anything is fetched or written", async () => {
    mkdirSync(stage, { recursive: true });
    writeFileSync(join(stage, "stale.txt"), "x");
    await expect(fetchVerifiedRegistryPackage(deps(), { id: ID }, stage)).rejects.toThrow(
      "ERR_REGISTRY_EXTRACT_FAILED",
    );
    expect(readdirSync(stage)).toEqual(["stale.txt"]);
    expect(getRegistry(db, "main")?.lastSequence).toBe(0);
  });

  test("an existing empty intoDir is accepted", async () => {
    mkdirSync(stage, { recursive: true });
    const pkg = await fetchVerifiedRegistryPackage(deps(), { id: ID }, stage);
    expect(existsSync(pkg.sourceRoot)).toBe(true);
  });

  test("a refusal after staging removes the staged files", async () => {
    rmSync(join(tmp, "registry"), { recursive: true, force: true });
    deleteRegistry(db, "main");
    reg = await buildTestRegistry(join(tmp, "registry"), {
      id: ID,
      versions: [{ version: "1.0.0" }],
      entryHashOverride: "0".repeat(64),
    });
    insertRegistry(db, {
      name: "main",
      url: join(tmp, "registry"),
      rootKey: reg.rootKey,
      rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: NOW,
      lastIndexSha256: null,
    });
    await expect(fetchVerifiedRegistryPackage(deps(), { id: ID }, stage)).rejects.toThrow(
      "ERR_REGISTRY_HASH_MISMATCH",
    );
    expect(readdirSync(stage)).toEqual([]);
  });
});
