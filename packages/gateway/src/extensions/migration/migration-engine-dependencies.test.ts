/**
 * A migration installs exactly ONE package (spec § 8.1, I44/I46). The owner's only answer is
 * `extension.migrate`, whose consent names the root alone, so the migration's install builds no
 * registry dependency resolver: a dependency resolves only against an installed copy (from any
 * source), an uninstalled one fails the accept, and nothing is ever fetched for a dependency.
 *
 * A separate file (not `migration-engine.test.ts`) so the existing migration tests stay unmodified;
 * its fixture is the same fixture continuity entry, with a registry carrying a dependency too.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";

import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { listExtensions } from "../../automation/extension-store.ts";
import { setPaused } from "../../sync/scheduler-store.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { ContinuityEntry } from "../continuity/continuity-table.ts";
import type { ReachRunner } from "../extension-reach.ts";
import { installExtensionFromLocalDirectory } from "../install-from-local.ts";
import { buildMultiExtensionRegistry } from "../registry/__fixtures__/build-test-registry.ts";
import type { BuiltinRegistryConfig } from "../registry/builtin-registry.ts";
import { getRunGrant } from "../run-grant-store.ts";
import { createMigrationEngine, type MigrationEngineDeps } from "./migration-engine.ts";
import { getMigration, listMigrations } from "./migration-store.ts";

/** A runner with a live posture: healthy per-host on Linux unless told otherwise. */
function reachRunner(
  confine: () => string | null,
  opts: {
    platform?: "linux" | "darwin" | "win32";
    fullyActive?: boolean;
    reason?: string | null;
  } = {},
): ReachRunner {
  const platform = opts.platform ?? "linux";
  const scopes = { win32: "all_or_nothing", darwin: "per_port" } as const;
  const scope = platform === "linux" ? undefined : scopes[platform];
  return {
    platform,
    isFullyActive: () => opts.fullyActive ?? true,
    degradedReason: () => opts.reason ?? null,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    canConfine: confine,
  };
}

const EXT = "com.example.reader";
const DEP = "com.example.reader.lib";
const LEGACY = "fixture_reader";
const LEGACY_KEY = "fixture_reader.token";
const HOST = "reader.example";
const BUILTIN_URL = "https://registry.nimbus.test/";
const NOW = Date.parse("2026-10-20T12:00:00Z");

const MANIFEST_EXTRA = {
  name: "Fixture Reader",
  permissions: { network: [HOST] },
  credentials: { token: { env: "FIXTURE_TOKEN" } },
  sync: { contract: "1", intervalSeconds: 600, itemTypes: ["highlight", "book"] },
};

let tmp: string;
let registryDir: string;
let builtin: BuiltinRegistryConfig;
let entry: ContinuityEntry;
let db: Database;
let vault: NimbusVault;
let fetches: string[];
/** The fake scheduler's registered service ids. */
let registered: Set<string>;

beforeEach(async () => {
  tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-migration-deps-")));
  registryDir = join(tmp, "official");
  // The official package depends on a library the same registry also publishes: a registry
  // install would fetch it; a migration must not.
  const built = await buildMultiExtensionRegistry(
    registryDir,
    {
      [EXT]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    },
    { publisherId: "nimbus", manifestExtra: MANIFEST_EXTRA },
  );
  builtin = { url: BUILTIN_URL, rootKey: built.rootKey };
  entry = {
    legacyServiceId: LEGACY,
    extensionId: EXT,
    publisherKey: built.publisherKey,
    sourceRootFingerprint: publisherKeyFingerprint(built.rootKey),
    credentials: { token: LEGACY_KEY },
    expectedPermissions: { network: [HOST], read: [], write: [] },
    itemTypes: ["highlight", "book"],
    displayName: "Fixture Reader",
  };
  db = openMemoryIndexDatabase();
  vault = createMemoryVault();
  await vault.set(LEGACY_KEY, "SECRET-TOKEN-VALUE-0123456789");
  fetches = [];
  registered = new Set();
});

afterEach(() => {
  db.close();
  rmDirWithRetry(tmp);
});

function deps(): MigrationEngineDeps {
  return {
    db,
    vault,
    dataDir: join(tmp, "data"),
    extensionsDir: join(tmp, "data", "extensions"),
    fetch: {
      fetchFn: async (url) => {
        fetches.push(url);
        const u = new URL(url);
        try {
          return new Response(
            readFileSync(join(registryDir, ...u.pathname.split("/").filter(Boolean))),
          );
        } catch {
          return new Response("missing", { status: 404 });
        }
      },
      enforceAirGap: () => false,
      now: () => NOW,
      production: false,
    },
    builtin,
    continuityTable: [entry],
    isBundledConnector: () => false,
    env: {
      platform: process.platform,
      protectedRoots: [join(tmp, "data"), join(tmp, "config")],
      runtimeReadPaths: [join(tmp, "bun-bin")],
      realpath: (p) => realpathSync.native(p),
    },
    runtimeEnabled: true,
    sandbox: reachRunner(() => null),
    // Mirrors the real registrar's contract: register a live, granted extension under the legacy id.
    extensionSync: {
      refresh: (id) => {
        registered.delete(LEGACY);
        if (listExtensions(db).some((r) => r.id === id) && getRunGrant(db, id) !== null) {
          registered.add(LEGACY);
        }
      },
    },
    scheduler: {
      resume: (id) => setPaused(db, id, false),
      pause: (id) => setPaused(db, id, true),
      syncableFor: (id) => (registered.has(id) ? { preflight: () => null } : undefined),
    },
    now: () => NOW,
  };
}

function onlyRowId(): string {
  const rows = listMigrations(db);
  const [row] = rows;
  if (rows.length !== 1 || row === undefined) throw new Error("premise: one migration row");
  return row.id;
}

const depFetches = (): string[] => fetches.filter((u) => u.includes(`/extensions/${DEP}/`));
const installedIds = (): string[] =>
  listExtensions(db)
    .map((r) => r.id)
    .sort();

/** Installs the dependency from a LOCAL folder (no registry source). */
async function installDepLocally(): Promise<void> {
  const local = join(tmp, "local-dep");
  mkdirSync(join(local, "dist"), { recursive: true });
  writeFileSync(join(local, "dist", "index.js"), "export const v = 1;");
  writeFileSync(
    join(local, "nimbus.extension.json"),
    JSON.stringify({ id: DEP, version: "1.0.0", entry: "dist/index.js", permissions: {} }),
  );
  await installExtensionFromLocalDirectory({
    db,
    extensionsDir: join(tmp, "data", "extensions"),
    sourcePath: local,
  });
}

describe("a migration installs exactly one package", () => {
  test("an uninstalled dependency fails accept: nothing is fetched for it, nothing is installed", async () => {
    const e = createMigrationEngine(deps());
    await e.evaluate();
    const id = onlyRowId();
    await expect(e.accept(id, async () => true)).rejects.toMatchObject({
      code: "ERR_EXTENSION_MIGRATION_FAILED",
    });
    expect(getMigration(db, id)?.state).toBe("failed");
    expect(depFetches()).toEqual([]);
    expect(installedIds()).toEqual([]);
    expect(getRunGrant(db, EXT)).toBeNull();
    // No install row of any kind was written for the refused plan.
    const installAudits = db
      .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'extension.install_complete'")
      .get() as { n: number };
    expect(installAudits.n).toBe(0);
  });

  test("a dependency installed from a local folder satisfies it, as before: accept succeeds", async () => {
    await installDepLocally();
    const e = createMigrationEngine(deps());
    await e.evaluate();
    const out = await e.accept(onlyRowId(), async () => true);
    expect(out.state).toBe("approved");
    expect(out.error ?? null).toBeNull();
    expect(installedIds()).toEqual([EXT, DEP].sort());
    expect(depFetches()).toEqual([]);
    expect(getRunGrant(db, EXT)).not.toBeNull();
  });
});
