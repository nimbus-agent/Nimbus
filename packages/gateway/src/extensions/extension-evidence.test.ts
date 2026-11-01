import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { diffPermissions, permissionsAfterUpdate } from "./auto-update-permissions-diff.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import { accessEvidence, approvalFields, updateAccessEvidence } from "./extension-evidence.ts";
import type { ReachRunner } from "./extension-reach.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { prevVersionDir } from "./version-store.ts";

const perHost: ReachRunner = {
  platform: "linux",
  isFullyActive: () => true,
  degradedReason: () => null,
  canConfine: () => null,
};

function env(
  paths: Record<string, string>,
  roots: string[] = ["/data/nimbus"],
): ExtensionRunGrantEnv {
  return {
    platform: "linux",
    protectedRoots: roots,
    runtimeReadPaths: [],
    realpath(p: string): string {
      const hit = paths[p];
      if (hit === undefined) throw new Error("ENOENT");
      return hit;
    },
  };
}

const perms = (network: string[], read: string[] = [], write: string[] = []) => ({
  network,
  filesystem: { read, write },
});

describe("accessEvidence", () => {
  test("undefined deps: unknown reach, declared files marked not checked", () => {
    const e = accessEvidence(undefined, perms(["a.com"], ["/x"]));
    expect(e.networkReach).toContain("not known here");
    expect(e.fileAccess).toContain("/x");
    expect(e.fileAccess).toEndWith("(not checked here)");
    expect(e.canRunHere).toBeNull();
    expect(e.checked).toBe(false);
  });

  test("a runner and an environment give a real reach and a real file outcome", () => {
    const e = accessEvidence(
      { sandbox: perHost, grantEnv: env({ "/ok": "/ok" }), homeDir: "/home/ada" },
      perms(["a.com", "b.com"], ["/ok"]),
    );
    expect(e.networkReach).toBe("network access to a.com, b.com");
    expect(e.canRunHere).toBe(true);
    expect(e.checked).toBe(true);
  });

  test("a protected path cannot run here", () => {
    const e = accessEvidence(
      { sandbox: perHost, grantEnv: env({ "/data/nimbus": "/data/nimbus" }), homeDir: "/home/ada" },
      perms([], [], ["/data/nimbus"]),
    );
    expect(e.canRunHere).toBe(false);
    expect(e.fileAccess).toContain("can't run here");
  });

  test("a preview that throws is stated, never thrown", () => {
    const boom: ExtensionRunGrantEnv = {
      ...env({ "/x": "/x" }),
      get protectedRoots(): readonly string[] {
        throw new TypeError("odd");
      },
    };
    const e = accessEvidence({ grantEnv: boom, homeDir: "/h" }, perms([], ["/x"]));
    expect(e.fileAccess).toContain("not known here");
    expect(e.canRunHere).toBeNull();
  });
});

describe("approvalFields", () => {
  test("keeps reach and files, and canRunHere only when false", () => {
    const base = { networkReach: "r", fileAccess: "f", checked: true };
    expect(approvalFields({ ...base, canRunHere: true })).toEqual({
      networkReach: "r",
      fileAccess: "f",
    });
    expect(approvalFields({ ...base, canRunHere: null })).toEqual({
      networkReach: "r",
      fileAccess: "f",
    });
    expect(approvalFields({ ...base, canRunHere: false })).toEqual({
      networkReach: "r",
      fileAccess: "f",
      canRunHere: false,
    });
  });
});

describe("permissionsAfterUpdate", () => {
  test("applies adds and removes, sorted and deduplicated", () => {
    const before = perms(["b.com", "a.com"], ["/r"], ["/w"]);
    const after = perms(["c.com", "b.com"], ["/r", "/r2"], []);
    expect(permissionsAfterUpdate(before, diffPermissions(before, after))).toEqual({
      network: ["b.com", "c.com"],
      filesystem: { read: ["/r", "/r2"], write: [] },
    });
  });
});

describe("updateAccessEvidence, through real manifests on disk", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const c of cleanups.splice(0).reverse()) c();
  });

  const manifest = (version: string, network: string[]): string =>
    JSON.stringify({
      id: "ev.ext",
      version,
      entry: "dist/index.js",
      permissions: { network, filesystem: { read: [], write: [] } },
    });

  function setup(installed: string | null) {
    const root = mkdtempSync(join(tmpdir(), "nimbus-evidence-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const extensionsDir = join(root, "extensions");
    const installPath = join(extensionsDir, "ev.ext");
    mkdirSync(installPath, { recursive: true });
    if (installed !== null) writeFileSync(join(installPath, "nimbus.extension.json"), installed);
    const db = new Database(":memory:");
    cleanups.push(() => db.close());
    LocalIndex.ensureSchema(db);
    insertExtensionRow(db, {
      id: "ev.ext",
      version: "1.0.0",
      install_path: installPath,
      manifest_hash: "m",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
    });
    return { db, extensionsDir, installPath };
  }

  const update = (diff: AvailableUpdate["permissionDiff"], toVersion = "1.1.0"): AvailableUpdate =>
    ({ id: "ev.ext", toVersion, permissionDiff: diff }) as AvailableUpdate;
  const net = (added: string[], removed: string[]): AvailableUpdate["permissionDiff"] => ({
    network: { added, removed },
    filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
  });
  const deps = { sandbox: perHost, homeDir: "/home/ada" };

  test("a forward update states the version after the diff only", () => {
    const { db, extensionsDir } = setup(manifest("1.0.0", ["a.com"]));
    const e = updateAccessEvidence(
      db,
      deps,
      update(net(["b.com"], ["a.com"])),
      undefined,
      "upgrade",
      extensionsDir,
    );
    expect(e?.networkReach).toBe("network access to b.com");
  });

  test("added packages' permissions are unioned in", () => {
    const { db, extensionsDir } = setup(manifest("1.0.0", ["a.com"]));
    const added = { network: ["c.com"], filesystem: { read: [], write: [] } };
    const e = updateAccessEvidence(db, deps, update(net([], [])), added, "upgrade", extensionsDir);
    expect(e?.networkReach).toBe("network access to a.com, c.com");
  });

  test("a downgrade states the rollback target's manifest, not the diff", () => {
    // 1.0 and 1.1 declare {a, d}; 1.2 is installed declaring {a}: the detection diff (1.2 vs
    // the version installed then) is empty, but the rollback restores d.
    const { db, extensionsDir } = setup(manifest("1.2.0", ["a.com"]));
    const prev = prevVersionDir(extensionsDir, "ev.ext", "1.1.0");
    mkdirSync(prev, { recursive: true });
    writeFileSync(join(prev, "nimbus.extension.json"), manifest("1.1.0", ["a.com", "d.com"]));
    const e = updateAccessEvidence(
      db,
      deps,
      update(net([], []), "1.1.0"),
      undefined,
      "downgrade",
      extensionsDir,
    );
    expect(e?.networkReach).toBe("network access to a.com, d.com");
  });

  test("a downgrade whose target is missing or corrupt is unreadable", () => {
    const { db, extensionsDir } = setup(manifest("1.2.0", ["a.com"]));
    const u = update(net([], []), "1.1.0");
    expect(
      updateAccessEvidence(db, deps, u, undefined, "downgrade", extensionsDir),
    ).toBeUndefined();
    const prev = prevVersionDir(extensionsDir, "ev.ext", "1.1.0");
    mkdirSync(prev, { recursive: true });
    writeFileSync(join(prev, "nimbus.extension.json"), "{not json");
    expect(
      updateAccessEvidence(db, deps, u, undefined, "downgrade", extensionsDir),
    ).toBeUndefined();
    expect(updateAccessEvidence(db, deps, u, undefined, "downgrade", undefined)).toBeUndefined();
  });

  test("no row, no manifest and a corrupt manifest are each unreadable", () => {
    const ok = setup(manifest("1.0.0", ["a.com"]));
    const missing = { ...update(net([], [])), id: "other.ext" } as AvailableUpdate;
    expect(
      updateAccessEvidence(ok.db, deps, missing, undefined, "upgrade", ok.extensionsDir),
    ).toBeUndefined();
    const none = setup(null);
    expect(
      updateAccessEvidence(
        none.db,
        deps,
        update(net([], [])),
        undefined,
        "upgrade",
        none.extensionsDir,
      ),
    ).toBeUndefined();
    const bad = setup("{not json");
    expect(
      updateAccessEvidence(
        bad.db,
        deps,
        update(net([], [])),
        undefined,
        "upgrade",
        bad.extensionsDir,
      ),
    ).toBeUndefined();
  });
});
