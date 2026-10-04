/**
 * Paths of `ExtensionAutoUpdater` that `auto-update.test.ts` does not reach: the two scheduled
 * polls `start()` arms (and that a failing poll is swallowed there), a `start()` whose jitter
 * source throws, and three dependency-solver lookups — an installed dependency the bump no longer
 * fits, a missing dependency the registry DOES carry, and an installed dependency's own on-disk
 * `dependsOn`.
 *
 * The timer tests swap `globalThis.setTimeout`/`setInterval` only around the SYNCHRONOUS body of
 * `start()`/`stop()` and restore them before anything is awaited, so no other code ever sees them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ExtensionAutoUpdater,
  type ExtensionAutoUpdaterOpts,
  type FetchManifestResult,
  type InstalledExtensionRow,
} from "./auto-update.ts";
import { AutoUpdateCache } from "./auto-update-cache.ts";

const FAKE_KEY = `${"x".repeat(43)}=`;
const FAKE_SIG = `${"y".repeat(86)}==`;
const NO_PERMISSIONS = { network: [], filesystem: { read: [], write: [] } };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function installedRow(
  id: string,
  version: string,
  installPath: string,
  dependsOn?: Readonly<Record<string, string>>,
): InstalledExtensionRow {
  return {
    id,
    version,
    install_path: installPath,
    enabled: 1,
    manifest: {
      id,
      version,
      updateChannel: "stable",
      publisher: { id: "pub.cov", key: FAKE_KEY },
      signature: FAKE_SIG,
      permissions: NO_PERMISSIONS,
      ...(dependsOn === undefined ? {} : { dependsOn }),
    },
  };
}

/** What the registry serves for `id@version`: a signed manifest with the given `dependsOn`. */
function registryManifest(
  id: string,
  version: string,
  dependsOn?: Readonly<Record<string, string>>,
): FetchManifestResult {
  return {
    manifest: {
      id,
      version,
      updateChannel: "stable",
      publisher: { id: "pub.cov", key: FAKE_KEY },
      signature: FAKE_SIG,
      permissions: NO_PERMISSIONS,
      ...(dependsOn === undefined ? {} : { dependsOn }),
    },
    manifestRaw: {},
    manifestHash: "h".repeat(64),
    entryHash: "e".repeat(64),
    tarballUrl: `https://registry.invalid/${id}-${version}.tgz`,
  };
}

function updater(overrides: Partial<ExtensionAutoUpdaterOpts>): {
  updater: ExtensionAutoUpdater;
  cache: AutoUpdateCache;
} {
  const cache = new AutoUpdateCache();
  const u = new ExtensionAutoUpdater({
    cache,
    listInstalled: async () => [],
    fetchLatestVersion: async () => null,
    fetchManifest: async (id, version) => registryManifest(id, version),
    verifyManifestSignature: async () => {},
    lookupPublisherKey: async () => new Uint8Array(32),
    appendAudit: async () => {},
    intervalHours: 2,
    enforceAirGap: false,
    now: () => 1_000,
    random: () => 0.5,
    ...overrides,
  });
  return { updater: u, cache };
}

interface Armed {
  readonly fn: () => void;
  readonly ms: number | undefined;
}

/** Runs `body` (synchronously) with the four timer globals replaced by recorders. */
function withRecordedTimers<T>(body: () => T): {
  result: T;
  timeouts: Armed[];
  intervals: Armed[];
  cleared: unknown[];
} {
  const real = {
    setTimeout: globalThis.setTimeout,
    setInterval: globalThis.setInterval,
    clearTimeout: globalThis.clearTimeout,
    clearInterval: globalThis.clearInterval,
  };
  const timeouts: Armed[] = [];
  const intervals: Armed[] = [];
  const cleared: unknown[] = [];
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    timeouts.push({ fn, ms });
    return "startup-handle";
  }) as unknown as typeof setTimeout;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    intervals.push({ fn, ms });
    return "periodic-handle";
  }) as unknown as typeof setInterval;
  globalThis.clearTimeout = ((h: unknown) => {
    cleared.push(h);
  }) as typeof clearTimeout;
  globalThis.clearInterval = ((h: unknown) => {
    cleared.push(h);
  }) as typeof clearInterval;
  try {
    return { result: body(), timeouts, intervals, cleared };
  } finally {
    Object.assign(globalThis, real);
  }
}

describe("start(): the two scheduled polls", () => {
  test("a jittered startup poll and a periodic poll are armed; both poll, and a failing poll is swallowed", async () => {
    let listed = 0;
    const { updater: u } = updater({
      listInstalled: async () => {
        listed += 1;
        throw new Error("extension table locked");
      },
      random: () => 0.5,
      intervalHours: 2,
    });

    const started = withRecordedTimers(() => u.start());
    await started.result;
    expect(u.isRunning()).toBe(true);
    // 30 s floor + 0.5 × the 270 s jitter window; the period is the configured interval.
    expect(started.timeouts.map((t) => t.ms)).toEqual([30_000 + 135_000]);
    expect(started.intervals.map((t) => t.ms)).toEqual([2 * 3_600_000]);

    // Fire both: each polls, and the rejected poll must not surface as an unhandled rejection.
    started.timeouts[0]?.fn();
    started.intervals[0]?.fn();
    await Bun.sleep(0);
    expect(listed).toBe(2);

    const stopped = withRecordedTimers(() => u.stop());
    await stopped.result;
    expect(stopped.cleared).toEqual(["startup-handle", "periodic-handle"]);
    expect(u.isRunning()).toBe(false);
  });

  test("a jitter source that throws rejects start() with no timer armed; stop() then clears nothing", async () => {
    const { updater: u } = updater({
      random: () => {
        throw new Error("entropy unavailable");
      },
    });

    const started = withRecordedTimers(() => u.start());
    await expect(started.result).rejects.toThrow("entropy unavailable");
    expect(started.timeouts).toEqual([]);
    expect(started.intervals).toEqual([]);

    const stopped = withRecordedTimers(() => u.stop());
    await stopped.result;
    expect(stopped.cleared).toEqual([]);
    expect(u.isRunning()).toBe(false);
  });
});

describe("dependency conflicts the solver finds for a bump", () => {
  test("an INSTALLED dependency the bump outgrows is a conflict naming the installed version; the registry is not asked", async () => {
    const asked: string[] = [];
    // `lib` is UNSIGNED, so `pollOnce` never checks it for an update of its own: any registry
    // lookup for it below could only have come from the solver.
    const lib = installedRow("com.cov.lib", "1.0.0", "/nonexistent/lib");
    const { publisher: _unsigned, signature: _noSig, ...unsignedManifest } = lib.manifest;
    const { updater: u, cache } = updater({
      listInstalled: async () => [
        installedRow("com.cov.root", "1.0.0", "/nonexistent/root"),
        { ...lib, manifest: unsignedManifest },
      ],
      fetchLatestVersion: async (id) => {
        asked.push(id);
        return id === "com.cov.root" ? { version: "2.0.0", channel: "stable" } : null;
      },
      fetchManifest: async (id, version) =>
        registryManifest(id, version, { "com.cov.lib": "^2.0.0" }),
      solverRemoteFetchManifest: async (id, version) => ({ id, version }),
    });

    await u.pollOnce();

    const conflicts = cache.get("com.cov.root")?.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts?.[0]).toMatchObject({
      kind: "unsatisfiable",
      id: "com.cov.lib",
      availableVersions: ["1.0.0"],
    });
    // Every constraint it names is the bump's own. (The solver learns that one constraint twice —
    // from the seeded active constraints and again while visiting the root — so it is compared
    // as a set here, not as a list.)
    const constraints = (conflicts?.[0] as { constraints?: unknown[] } | undefined)?.constraints;
    expect(new Set(constraints?.map((c) => JSON.stringify(c)))).toEqual(
      new Set([JSON.stringify({ from: "com.cov.root", range: "^2.0.0" })]),
    );
    // The installed version is the only candidate: the solver never asked the registry for lib.
    expect(asked).toEqual(["com.cov.root"]);
  });

  test("a MISSING dependency the registry carries is resolved from the registry, with no conflict", async () => {
    const remote: string[] = [];
    const latestAsked: Array<[string, string]> = [];
    const { updater: u, cache } = updater({
      listInstalled: async () => [installedRow("com.cov.root2", "1.0.0", "/nonexistent/root2")],
      fetchLatestVersion: async (id, channel) => {
        latestAsked.push([id, channel]);
        if (id === "com.cov.root2") return { version: "2.0.0", channel: "stable" };
        if (id === "com.cov.newdep") return { version: "1.4.0", channel: "stable" };
        return null;
      },
      fetchManifest: async (id, version) =>
        registryManifest(id, version, { "com.cov.newdep": "^1.0.0" }),
      solverRemoteFetchManifest: async (id, version) => {
        remote.push(`${id}@${version}`);
        return { id, version };
      },
    });

    await u.pollOnce();

    const entry = cache.get("com.cov.root2");
    expect(entry?.toVersion).toBe("2.0.0");
    expect(entry?.conflicts).toBeUndefined();
    expect(latestAsked).toContainEqual(["com.cov.newdep", "stable"]);
    expect(remote).toEqual(["com.cov.newdep@1.4.0"]);
  });

  test("an installed dependency's OWN on-disk dependsOn is followed to a transitive conflict", async () => {
    // root bumps to 2.0.0 and now needs `mid`; installed `mid`'s manifest ON DISK needs `leaf`
    // ^2.0.0, while `leaf` is installed at 1.0.0. Only by reading `mid`'s file does the solver
    // ever visit `leaf` at all.
    const root = mkdtempSync(join(tmpdir(), "nimbus-au-cov-"));
    dirs.push(root);
    const midDir = join(root, "mid");
    const leafDir = join(root, "leaf");
    mkdirSync(midDir, { recursive: true });
    mkdirSync(leafDir, { recursive: true });
    writeFileSync(
      join(midDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "com.cov.mid",
        version: "1.0.0",
        permissions: {},
        dependsOn: { "com.cov.leaf": "^2.0.0" },
      }),
    );
    writeFileSync(
      join(leafDir, "nimbus.extension.json"),
      JSON.stringify({ id: "com.cov.leaf", version: "1.0.0", permissions: {} }),
    );
    const remote: string[] = [];
    const { updater: u, cache } = updater({
      listInstalled: async () => [
        installedRow("com.cov.top", "1.0.0", join(root, "top")),
        installedRow("com.cov.mid", "1.0.0", midDir, { "com.cov.leaf": "^2.0.0" }),
        installedRow("com.cov.leaf", "1.0.0", leafDir),
      ],
      fetchLatestVersion: async (id) =>
        id === "com.cov.top" ? { version: "2.0.0", channel: "stable" } : null,
      fetchManifest: async (id, version) =>
        registryManifest(id, version, { "com.cov.mid": "^1.0.0" }),
      solverRemoteFetchManifest: async (id, version) => {
        remote.push(`${id}@${version}`);
        return { id, version };
      },
    });

    await u.pollOnce();

    const conflicts = cache.get("com.cov.top")?.conflicts;
    expect(conflicts).toHaveLength(1);
    expect(conflicts?.[0]).toMatchObject({
      kind: "unsatisfiable",
      id: "com.cov.leaf",
      availableVersions: ["1.0.0"],
    });
    expect((conflicts?.[0] as { constraints?: unknown[] } | undefined)?.constraints).toContainEqual(
      { from: "com.cov.mid", range: "^2.0.0" },
    );
    // `mid` was read from its install path, never fetched remotely.
    expect(remote).toEqual([]);
  });
});
