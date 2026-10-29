import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DependencySpec,
  RegistryError,
  type RegistryIndex,
} from "@nimbus-dev/registry-format";

import {
  ExtensionAutoUpdater,
  type ExtensionAutoUpdaterOpts,
  type InstalledExtensionRow,
} from "./auto-update.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";
import type {
  AddedPackage,
  AvailableUpdate,
  UpdatePlan,
  UpdatePlanContext,
} from "./auto-update-types.ts";
import { DependencyConflictError, OfflineDependencyResolutionError } from "./dependency-errors.ts";
import type { ExtensionManifestForSolver } from "./dependency-types.ts";
import type { RegistryDependencyResolver } from "./registry/registry-dependency-fetcher.ts";
import type {
  CollectedRegistryUpdates,
  InstalledRegistryRow,
} from "./registry/registry-update-source.ts";

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
  dependsOn: Record<string, Record<string, DependencySpec>> = {},
): CollectedRegistryUpdates {
  return {
    updates,
    errors: [],
    dependsOn: new Map(Object.entries(dependsOn)),
    requires: new Map(),
  };
}

/** A resolver that was never asked anything: the daemon tests fake the whole plan. */
const IDLE_RESOLVER: RegistryDependencyResolver = {
  fetcher: {
    targetSource: () => null,
    listVersions: async () => [],
    fetchManifest: async (id) => {
      throw new Error(`${id} is not fetched in this test`);
    },
  },
  rootSource: "main#test",
  verified: () => undefined,
  registryUrl: () => null,
  stage: async () => [],
};

function planned(addedPackages: AddedPackage[]): UpdatePlan {
  return { resolver: IDLE_RESOLVER, plan: { nodes: [] }, addedPackages };
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
    planUpdate: async () => planned([]),
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
        dependsOn: new Map(),
        requires: new Map(),
      },
    ]);
    await t.daemon.pollOnce();
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.toVersion).toBe("1.2.0");
  });

  it("an error from ANOTHER registry does not keep an offer its own registry stopped making", async () => {
    const t = ticking([
      collected([update("com.a")]),
      {
        updates: [],
        errors: [{ registry: "other", error: "down" }],
        dependsOn: new Map(),
        requires: new Map(),
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

describe("ExtensionAutoUpdater: detection plans the update's dependencies", () => {
  /** A daemon whose `planUpdate` is `plan`, recording the manifests it was asked to plan. */
  function planning(
    plan: (update: AvailableUpdate, m: ExtensionManifestForSolver) => Promise<UpdatePlan>,
    over: Partial<ExtensionAutoUpdaterOpts> = {},
  ) {
    const asked: ExtensionManifestForSolver[] = [];
    const t = daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () =>
        collected([update("com.a")], {
          "com.a": { "com.dep": { range: "^1.0.0", registry: "https://other.test/" } },
        }),
      planUpdate: (u, m) => {
        asked.push(m);
        return plan(u, m);
      },
      ...over,
    });
    return { ...t, asked };
  }

  it("detection keeps the dependency's registry: the plan gets the full specs", async () => {
    const t = planning(async () => planned([]));
    await t.daemon.pollOnce();
    expect(t.asked).toEqual([
      {
        id: "com.a",
        version: "1.2.0",
        dependsOn: { "com.dep": { range: "^1.0.0", registry: "https://other.test/" } },
      },
    ]);
    // Cached too: the approval re-plans from these specs.
    expect(t.cache.get("com.a")?.dependsOn).toEqual({
      "com.dep": { range: "^1.0.0", registry: "https://other.test/" },
    });
  });

  it("an update adding a fetchable dependency lists it as an added package, not a conflict", async () => {
    const added = { id: "com.dep", version: "1.1.0", registry: "other", registryUrl: null };
    const t = planning(async () => planned([added]));
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts).toBeUndefined();
    expect(t.cache.get("com.a")?.addedPackages).toEqual([added]);
  });

  it("a dependency conflict is cached as a conflict with a one-line reason", async () => {
    const t = planning(async () => {
      throw new DependencyConflictError({
        kind: "unsatisfiable",
        id: "com.a",
        constraints: [{ from: "com.user", range: "~1.0.0" }],
        availableVersions: ["1.2.0"],
      });
    });
    await t.daemon.pollOnce();
    const cached = t.cache.get("com.a");
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toEqual([
      {
        kind: "unsatisfiable",
        id: "com.a",
        constraints: [{ from: "com.user", range: "~1.0.0" }],
        availableVersions: ["1.2.0"],
        reason: "com.a: no version satisfies ~1.0.0 (from com.user); available: 1.2.0",
      },
    ]);
  });

  it("a registry refusal is cached as a conflict with its code and reason", async () => {
    const t = planning(async () => {
      throw new RegistryError("ERR_DEPENDENCY_REGISTRY_NOT_ADDED", "com.dep comes from x;\nadd it");
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.conflicts).toEqual([
      {
        kind: "registry",
        code: "ERR_DEPENDENCY_REGISTRY_NOT_ADDED",
        reason: "ERR_DEPENDENCY_REGISTRY_NOT_ADDED: com.dep comes from x; add it",
      },
    ]);
  });

  it("an offline resolution is an offline conflict and caches no added packages", async () => {
    const t = planning(async () => {
      throw new OfflineDependencyResolutionError({ missingId: "com.dep", parent: "com.a" });
    });
    await t.daemon.pollOnce();
    const cached = t.cache.get("com.a");
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toEqual([
      {
        kind: "offline",
        id: "com.dep",
        parent: "com.a",
        reason: "offline_dependency_resolution:com.dep (required by com.a)",
      },
    ]);
  });

  it("an unexpected planning failure is an unplanned conflict, never a clean update", async () => {
    const t = planning(async () => {
      throw new Error('source_registry_changed: registry "main" was removed');
    });
    await t.daemon.pollOnce();
    const cached = t.cache.get("com.a");
    expect(cached?.toVersion).toBe("1.2.0");
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toEqual([
      {
        kind: "registry",
        code: "ERR_UPDATE_UNPLANNED",
        reason:
          'ERR_UPDATE_UNPLANNED: the update could not be planned: source_registry_changed: registry "main" was removed',
      },
    ]);
  });

  for (const status of ["signature_failed", "publisher_key_conflict"] as const) {
    it(`an update whose status is ${status} is not planned`, async () => {
      let asked = 0;
      const t = daemon({
        listInstalled: async () => [installed("com.a")],
        collect: async () => collected([{ ...update("com.a"), verificationStatus: status }]),
        planUpdate: async () => {
          asked += 1;
          return planned([]);
        },
      });
      await t.daemon.pollOnce();
      const cached = t.cache.get("com.a");
      expect(asked).toBe(0);
      expect(cached?.verificationStatus).toBe(status);
      expect(cached?.conflicts).toBeUndefined();
      expect(cached?.addedPackages).toBeUndefined();
    });
  }

  it("the plan reuses the source index verified this tick and gets the daemon's signal", async () => {
    const index = { marker: "verified this tick" } as unknown as RegistryIndex;
    const contexts: UpdatePlanContext[] = [];
    const t = daemon({
      listInstalled: async () => [installed("com.a")],
      collect: async () => ({
        ...collected([update("com.a")]),
        indexes: new Map([[`main#${SOURCE.rootFingerprint}`, index]]),
      }),
      planUpdate: async (_u, _m, context) => {
        contexts.push(context);
        return planned([]);
      },
    });
    await t.daemon.pollOnce();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.index).toBe(index);
    expect(contexts[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a new connector requirement is listed in addedRequirements", async () => {
    const row = installed("com.a");
    row.manifest.requires = { connectors: ["github"] };
    const t = planning(async () => planned([]), {
      listInstalled: async () => [row],
      collect: async () => ({
        ...collected([update("com.a")]),
        requires: new Map([["com.a", ["github", "slack"]]]),
      }),
    });
    await t.daemon.pollOnce();
    expect(t.cache.get("com.a")?.addedRequirements).toEqual(["slack"]);
  });

  it("no new connector requirement leaves addedRequirements unset", async () => {
    const row = installed("com.a");
    row.manifest.requires = { connectors: ["github"] };
    const t = planning(async () => planned([]), {
      listInstalled: async () => [row],
      collect: async () => ({
        ...collected([update("com.a")]),
        requires: new Map([["com.a", ["github"]]]),
      }),
    });
    await t.daemon.pollOnce();
    expect("addedRequirements" in (t.cache.get("com.a") ?? {})).toBe(false);
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
