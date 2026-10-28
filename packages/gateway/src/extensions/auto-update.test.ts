import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExtensionAutoUpdater,
  type ExtensionAutoUpdaterOpts,
  type InstalledExtensionRow,
} from "./auto-update.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";
import type { AvailableUpdate } from "./auto-update-types.ts";
import type {
  CollectedRegistryUpdates,
  InstalledRegistryRow,
} from "./registry/registry-update-source.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NO_PERMISSIONS = { network: [], filesystem: { read: [], write: [] } };
const SOURCE = { registry: "main", rootFingerprint: "f".repeat(32), channel: "stable" as const };

function installed(
  id: string,
  over: Partial<InstalledExtensionRow> & { dependsOn?: Readonly<Record<string, string>> } = {},
): InstalledExtensionRow {
  const { dependsOn, ...rest } = over;
  return {
    id,
    version: "1.0.0",
    install_path: join(tmpdir(), "nimbus-never-read", id),
    enabled: 1,
    source: SOURCE,
    manifest: {
      id,
      version: "1.0.0",
      updateChannel: "stable",
      publisher: { id: "acme", key: `${"x".repeat(43)}=` },
      signature: `${"y".repeat(86)}==`,
      permissions: NO_PERMISSIONS,
      ...(dependsOn === undefined ? {} : { dependsOn }),
    },
    ...rest,
  };
}

function update(id: string, toVersion = "1.2.0"): AvailableUpdate {
  return {
    id,
    displayName: id,
    fromVersion: "1.0.0",
    toVersion,
    channel: "stable",
    changelog: "",
    publisherStatus: "verified",
    manifestHash: "a".repeat(64),
    signatureB64: "sig",
    entryHash: "e".repeat(64),
    packageSha256: "b".repeat(64),
    packageSizeBytes: 10,
    sourceRegistry: "main",
    rootFingerprint: SOURCE.rootFingerprint,
    packagePath: `extensions/${id}/${toVersion}/package.tgz`,
    permissionDiff: {
      network: { added: [], removed: [] },
      filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
    },
    verificationStatus: "verified",
    detectedAt: 1,
  };
}

function collected(
  updates: AvailableUpdate[],
  dependsOn: Record<string, Record<string, string>> = {},
): CollectedRegistryUpdates {
  return { updates, errors: [], refused: [], dependsOn: new Map(Object.entries(dependsOn)) };
}

function daemon(over: Partial<ExtensionAutoUpdaterOpts>): {
  daemon: ExtensionAutoUpdater;
  cache: AutoUpdateCache;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
  polled: InstalledRegistryRow[][];
} {
  const cache = new AutoUpdateCache();
  const audits: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const polled: InstalledRegistryRow[][] = [];
  const d = new ExtensionAutoUpdater({
    cache,
    listInstalled: async () => [],
    collect: async (rows) => {
      polled.push(rows);
      return collected([]);
    },
    appendAudit: async (type, payload) => {
      audits.push({ type, payload });
    },
    intervalHours: 6,
    now: () => 1,
    random: () => 0,
    ...over,
  });
  return { daemon: d, cache, audits, polled };
}

describe("ExtensionAutoUpdater.pollOnce", () => {
  it("local-path installs are never polled", async () => {
    const local = installed("com.local");
    delete local.source;
    const t = daemon({ listInstalled: async () => [local] });
    await t.daemon.pollOnce();
    expect(t.polled).toEqual([]);
  });

  it("hands collect only enabled, signed, registry-sourced rows", async () => {
    const unsigned = installed("com.unsigned");
    delete unsigned.manifest.publisher;
    const t = daemon({
      listInstalled: async () => [
        installed("com.a"),
        installed("com.off", { enabled: 0 }),
        unsigned,
      ],
    });
    await t.daemon.pollOnce();
    expect(t.polled).toHaveLength(1);
    expect(t.polled[0]?.map((r) => [r.id, r.publisherId, r.source.registry])).toEqual([
      ["com.a", "acme", "main"],
    ]);
  });

  it("caches each update and audits the first detection only", async () => {
    const t = daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () => collected([update("com.a")]),
    });
    await t.daemon.pollOnce();
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.toVersion).toBe("1.2.0");
    expect(t.audits).toEqual([
      {
        type: "extension.autoUpdate.detected",
        payload: {
          id: "com.a",
          fromVersion: "1.0.0",
          toVersion: "1.2.0",
          channel: "stable",
          source_registry: "main",
          verification_status: "verified",
        },
      },
    ]);
  });

  it("a registry added after boot is polled on the next tick", async () => {
    // The daemon reads the CURRENT install table every tick; nothing is captured at construction.
    let rows: InstalledExtensionRow[] = [];
    const t = daemon({ listInstalled: async () => rows });
    await t.daemon.pollOnce();
    expect(t.polled).toEqual([]);
    rows = [installed("com.a")];
    await t.daemon.pollOnce();
    expect(t.polled).toHaveLength(1);
  });

  it("a collect failure rejects the tick (start() swallows it) without caching anything", async () => {
    const t = daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () => {
        throw new Error("boom");
      },
    });
    await expect(t.daemon.pollOnce()).rejects.toThrow("boom");
    expect(t.cache.list()).toEqual([]);
  });
});

describe("ExtensionAutoUpdater: an offer lasts only while its source registry offers it", () => {
  /** A daemon whose `collect` answers from a queue, one result per tick. */
  function ticking(results: CollectedRegistryUpdates[]) {
    return daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () => results.shift() ?? collected([]),
    });
  }

  it("a registry that answered without the update drops it (removed, re-pinned or re-signed)", async () => {
    // `collect` skips a removed or re-pinned registry, and a re-signed index without the version
    // reports nothing for it: either way the next tick neither re-reports nor errors.
    const t = ticking([collected([update("com.a")]), collected([])]);
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.toVersion).toBe("1.2.0");
    await t.daemon.pollOnce();
    expect(t.cache.list()).toEqual([]);
  });

  it("a registry that ERRORED this tick keeps its offer (no flapping on a transient failure)", async () => {
    const t = ticking([
      collected([update("com.a")]),
      {
        updates: [],
        errors: [{ registry: "main", error: "ERR_REGISTRY_UNREACHABLE" }],
        refused: [],
        dependsOn: new Map(),
      },
    ]);
    await t.daemon.pollOnce();
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.toVersion).toBe("1.2.0");
  });

  it("a refused update in the same registry does not keep an offer that registry stopped making", async () => {
    const t = ticking([
      collected([update("com.a")]),
      {
        updates: [],
        errors: [],
        refused: [
          { registry: "main", id: "com.b", error: "ERR_EXTENSION_MANIFEST_UNSUPPORTED: …" },
        ],
        dependsOn: new Map(),
      },
    ]);
    await t.daemon.pollOnce();
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")).toBeUndefined();
  });

  it("an error from ANOTHER registry does not keep an offer its own registry stopped making", async () => {
    const t = ticking([
      collected([update("com.a")]),
      {
        updates: [],
        errors: [{ registry: "other", error: "down" }],
        refused: [],
        dependsOn: new Map(),
      },
    ]);
    await t.daemon.pollOnce();
    await t.daemon.pollOnce();
    expect(t.cache.list()).toEqual([]);
  });

  it("with no registry-sourced extension left, every offer is dropped", async () => {
    let rows: InstalledExtensionRow[] = [installed("com.a")];
    const t = daemon({
      listInstalled: async () => rows,
      collect: async () => collected([update("com.a")]),
    });
    await t.daemon.pollOnce();
    rows = [];
    await t.daemon.pollOnce();
    expect(t.cache.list()).toEqual([]);
  });

  it("one failed audit append does not stop the rest of the tick", async () => {
    const failures: string[] = [];
    const t = daemon({
      listInstalled: async () => [installed("com.a"), installed("com.b")],
      collect: async () => collected([update("com.a"), update("com.b")]),
      appendAudit: async (_type, payload) => {
        if (payload["id"] === "com.a") throw new Error("audit chain locked");
      },
      onTickError: (id) => failures.push(id),
    });
    await t.daemon.pollOnce();
    expect(
      t.cache
        .list()
        .map((u) => u.id)
        .sort(),
    ).toEqual(["com.a", "com.b"]);
    expect(failures).toEqual(["com.a"]);
  });
});

describe("ExtensionAutoUpdater: dependency conflicts against what is installed", () => {
  function manifestDir(id: string, version: string, dependsOn?: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-au-dep-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "nimbus.extension.json"),
      JSON.stringify({
        id,
        version,
        entry: "dist/index.js",
        permissions: {},
        ...(dependsOn === undefined ? {} : { dependsOn }),
      }),
    );
    return dir;
  }

  it("a new dependency that is not installed is a conflict (nothing is fetched)", async () => {
    const t = daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () => collected([update("com.a")], { "com.a": { "com.dep": "^1.0.0" } }),
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts).toHaveLength(1);
    expect(t.cache.get("com.a")?.conflicts?.[0]).toMatchObject({
      kind: "unsatisfiable",
      id: "com.dep",
      availableVersions: [],
    });
  });

  it("a bump an installed dependent's range excludes is a conflict", async () => {
    const t = daemon({
      listInstalled: async () => [
        installed("com.a"),
        installed("com.user", { dependsOn: { "com.a": "~1.0.0" } }),
      ],
      collect: async () => collected([update("com.a")]),
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts?.[0]).toMatchObject({
      kind: "unsatisfiable",
      id: "com.a",
      constraints: [{ from: "com.user", range: "~1.0.0" }],
    });
  });

  it("an installed dependency that satisfies the new range leaves no conflict", async () => {
    const depDir = manifestDir("com.dep", "1.4.0");
    const t = daemon({
      listInstalled: async () => [
        installed("com.a"),
        installed("com.dep", { version: "1.4.0", install_path: depDir }),
      ],
      collect: async () => collected([update("com.a")], { "com.a": { "com.dep": "^1.0.0" } }),
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts).toBeUndefined();
  });

  it("an installed dependency's own on-disk dependsOn is followed to a transitive conflict", async () => {
    const depDir = manifestDir("com.dep", "1.4.0", { "com.deeper": "^2.0.0" });
    const t = daemon({
      listInstalled: async () => [
        installed("com.a"),
        installed("com.dep", { version: "1.4.0", install_path: depDir }),
      ],
      collect: async () => collected([update("com.a")], { "com.a": { "com.dep": "^1.0.0" } }),
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts?.[0]).toMatchObject({ id: "com.deeper" });
  });
});

describe("ExtensionAutoUpdater start/stop", () => {
  it("starts even when nothing is installed, and stop is idempotent", async () => {
    const t = daemon({});
    await t.daemon.start();
    expect(t.daemon.isRunning()).toBe(true);
    await t.daemon.start();
    await t.daemon.stop();
    await t.daemon.stop();
    expect(t.daemon.isRunning()).toBe(false);
  });
});
