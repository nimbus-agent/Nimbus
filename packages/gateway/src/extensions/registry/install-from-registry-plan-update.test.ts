/**
 * `planUpdate` (extension dependencies PR 5): an update's new dependencies are solved through the
 * same registry-scoped resolver a registry install uses (I44), so a dependency the registries carry
 * becomes an added package, while a range an installed dependent pins, or a registry the owner has
 * not added, is a conflict. The daemon's detection (`createAutoUpdateRuntime`, the production
 * wiring) caches what the plan found.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  publisherKeyFingerprint,
  RegistryError,
  signTrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { getExtensionKind, isInstalledAsDependency } from "../../automation/extension-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { createAutoUpdateRuntime } from "../auto-update-init.ts";
import { _resetAutoUpdateMutexForTests, dispatchAutoUpdateRpc } from "../auto-update-rpc.ts";
import { DependencyConflictError } from "../dependency-errors.ts";
import { forwardDeps } from "../dependency-store.ts";
import type { ExtensionManifestForSolver } from "../dependency-types.ts";
import { getRunGrant, upsertRunGrant } from "../run-grant-store.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import { encodeBase64 } from "../verify-signature.ts";
import { prevVersionDir, prevVersionsDir } from "../version-store.ts";
import {
  buildMultiExtensionRegistry,
  resignIndex,
  type TestVersion,
} from "./__fixtures__/build-test-registry.ts";
import {
  type InstallFromRegistryDeps,
  installFromRegistry,
  planUpdate,
} from "./install-from-registry.ts";
import { getExtensionSource, insertRegistry } from "./registry-store.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");

let db: Database;
let tmp: string;
let vault: MockVault;
let rootKey: string;
/** Remote registries are served from these folders by a fake `fetchFn`: `https://<name>.test/`. */
const served = new Map<string, string>();

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 78);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-planupd-"));
  vault = new MockVault();
  served.clear();
  airGapped = false;
  beforeServe = undefined;
});

function ledger(method: string): number {
  const row = db.query("SELECT COUNT(*) AS n FROM egress_ledger WHERE method = ?").get(method);
  return (row as { n: number }).n;
}

afterEach(() => {
  db.close();
  rmDirWithRetry(tmp);
});

/** Whether the fake gateway is air-gapped: remote registries are then refused before any request. */
let airGapped = false;

/** Runs before the fake network serves each request (a test may change the disk underneath). */
let beforeServe: ((url: string) => void) | undefined;

/**
 * A registry carrying `exts`, added as an owner registry: remote (`https://<name>.test/`, served
 * from its folder) unless `local`, whose URL is the folder itself.
 */
async function addRegistry(
  name: string,
  exts: Record<string, TestVersion[]>,
  opts: { local?: boolean; extra?: Parameters<typeof buildMultiExtensionRegistry>[2] } = {},
): Promise<void> {
  const dir = join(tmp, name);
  rootKey = (await buildMultiExtensionRegistry(dir, exts, opts.extra)).rootKey;
  if (opts.local !== true) served.set(name, dir);
  insertRegistry(db, {
    name,
    url: opts.local === true ? dir : `https://${name}.test/`,
    rootKey,
    rootFingerprint: publisherKeyFingerprint(rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
}

function fetchBag(): InstallFromRegistryDeps["fetch"] {
  return {
    fetchFn: async (url) => {
      beforeServe?.(url);
      const u = new URL(url);
      const dir = served.get(u.hostname.replace(/\.test$/, ""));
      if (dir === undefined) return new Response("down", { status: 503 });
      try {
        return new Response(readFileSync(join(dir, ...u.pathname.split("/").filter(Boolean))));
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
    enforceAirGap: () => airGapped,
    now: () => NOW,
    production: false,
    builtin: null,
  };
}

function deps(): InstallFromRegistryDeps {
  return {
    db,
    extensionsDir: join(tmp, "extensions"),
    vault,
    fetch: fetchBag(),
    approve: async () => true,
    planStagingRoot: tmp,
  };
}

function updateTo(id: string, toVersion: string) {
  return {
    id,
    toVersion,
    channel: "stable" as const,
    sourceRegistry: "main",
    rootFingerprint: publisherKeyFingerprint(rootKey),
  };
}

function manifestAt(
  id: string,
  version: string,
  dependsOn?: ExtensionManifestForSolver["dependsOn"],
): ExtensionManifestForSolver {
  return { id, version, ...(dependsOn === undefined ? {} : { dependsOn }) };
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const ROOT = "com.example.root";
const DEP = "com.example.dep";

describe("planUpdate", () => {
  test("an update adding a fetchable dependency lists it as an added package, not a conflict", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }, { version: "1.1.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const plan = await planUpdate(
      deps(),
      updateTo(ROOT, "1.2.0"),
      manifestAt(ROOT, "1.2.0", { [DEP]: { range: "^1.0.0" } }),
    );
    expect(plan.addedPackages).toEqual([
      { id: DEP, version: "1.1.0", registry: "main", registryUrl: "https://main.test/" },
    ]);
    expect(plan.plan.nodes.find((n) => n.id === ROOT)).toMatchObject({
      version: "1.2.0",
      newlyInstalled: true,
    });
    // The solve verified exactly what it planned, so the apply can stage it.
    expect(plan.resolver.verified(DEP, "1.1.0")?.reg.name).toBe("main");
  });

  test("an installed dependency that satisfies the new range adds nothing", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(deps(), { id: DEP });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const plan = await planUpdate(
      deps(),
      updateTo(ROOT, "1.2.0"),
      manifestAt(ROOT, "1.2.0", { [DEP]: { range: "^1.0.0" } }),
    );
    expect(plan.addedPackages).toEqual([]);
  });

  test("the old version's own edges do not constrain the update", async () => {
    // 1.0.0 needs dep ~1.0.0; 1.2.0 needs ^2.0.0. The installed 1.0.0 edge must not veto 2.x.
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0", dependsOn: { [DEP]: "~1.0.0" } },
        { version: "1.2.0", dependsOn: { [DEP]: "^2.0.0" } },
      ],
      [DEP]: [{ version: "1.0.0" }, { version: "2.0.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const e = await rejectionOf(
      planUpdate(
        deps(),
        updateTo(ROOT, "1.2.0"),
        manifestAt(ROOT, "1.2.0", { [DEP]: { range: "^2.0.0" } }),
      ),
    );
    // dep 1.0.0 is installed and pinned (never replaced by a plan), so 2.x is unsatisfiable — but
    // the reported constraint is the NEW version's, not the old edge.
    expect(e).toBeInstanceOf(DependencyConflictError);
    expect((e as DependencyConflictError).conflict.constraints).toEqual([
      { from: ROOT, range: "^2.0.0" },
    ]);
  });

  test("an update whose dependency names an unadded registry is a conflict naming the registry add command", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://elsewhere.test/" } },
        },
      ],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const e = await rejectionOf(
      planUpdate(
        deps(),
        updateTo(ROOT, "1.2.0"),
        manifestAt(ROOT, "1.2.0", {
          [DEP]: { range: "^1.0.0", registry: "https://elsewhere.test/" },
        }),
      ),
    );
    expect(e).toBeInstanceOf(RegistryError);
    expect((e as RegistryError).code).toBe("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
    expect((e as RegistryError).message).toContain("nimbus registry add");
  });

  test("a dependent's range that excludes the new version is still a conflict", async () => {
    const USER = "com.example.user";
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0" }],
      [USER]: [{ version: "1.0.0", dependsOn: { [ROOT]: "~1.0.0" } }],
    });
    await installFromRegistry(deps(), { id: USER });
    const e = await rejectionOf(
      planUpdate(deps(), updateTo(ROOT, "1.2.0"), manifestAt(ROOT, "1.2.0")),
    );
    expect(e).toBeInstanceOf(DependencyConflictError);
    expect((e as DependencyConflictError).conflict).toMatchObject({
      kind: "unsatisfiable",
      id: ROOT,
      constraints: [{ from: USER, range: "~1.0.0" }],
    });
  });

  test("a source registry removed or re-pinned since detection is refused", async () => {
    await addRegistry("main", { [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0" }] });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const e = await rejectionOf(
      planUpdate(
        deps(),
        { ...updateTo(ROOT, "1.2.0"), rootFingerprint: "0".repeat(32) },
        manifestAt(ROOT, "1.2.0"),
      ),
    );
    expect(String(e)).toContain("source_registry_changed");
  });

  test("a manifest that is not the update's version is refused", async () => {
    await addRegistry("main", { [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0" }] });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    await expect(
      planUpdate(deps(), updateTo(ROOT, "1.2.0"), manifestAt(ROOT, "1.3.0")),
    ).rejects.toThrow("1.3.0");
  });
});

describe("update detection plans the update through the registries", () => {
  function runtime() {
    return createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmp, "extensions"),
      dataDir: join(tmp, "data"),
      fetch: fetchBag(),
      intervalHours: 24,
    });
  }

  test("an update adding a fetchable dependency lists it as an added package, not a conflict", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.toVersion).toBe("1.2.0");
    expect(cached?.conflicts).toBeUndefined();
    expect(cached?.addedPackages).toEqual([
      { id: DEP, version: "1.0.0", registry: "main", registryUrl: "https://main.test/" },
    ]);
  });

  test("an update whose dependency names an unadded registry is a conflict naming the registry add command", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://elsewhere.test/" } },
        },
      ],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toHaveLength(1);
    expect(cached?.conflicts?.[0]).toMatchObject({
      kind: "registry",
      code: "ERR_DEPENDENCY_REGISTRY_NOT_ADDED",
    });
    expect(cached?.conflicts?.[0]?.reason).toContain("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
    expect(cached?.conflicts?.[0]?.reason).toContain("nimbus registry add");
  });

  test("a dependent's range that excludes the new version is still a conflict", async () => {
    const USER = "com.example.user";
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0" }],
      [USER]: [{ version: "1.0.0", dependsOn: { [ROOT]: "~1.0.0" } }],
    });
    await installFromRegistry(deps(), { id: USER });
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.conflicts?.[0]).toMatchObject({
      kind: "unsatisfiable",
      id: ROOT,
      constraints: [{ from: USER, range: "~1.0.0" }],
    });
    expect(cached?.conflicts?.[0]?.reason).toContain("~1.0.0");
  });

  test("a new connector requirement is listed in addedRequirements", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0", requires: { connectors: ["github"] } },
        { version: "1.2.0", requires: { connectors: ["github", "slack"] } },
      ],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.conflicts).toBeUndefined();
    expect(cached?.addedPackages).toEqual([]);
    expect(cached?.addedRequirements).toEqual(["slack"]);
  });

  test("the source index read this tick is reused: one index request per registry per poll", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const rt = runtime();
    const before = ledger("registry.index");
    await rt.deps.forcePoll();
    expect(rt.deps.cache.get(ROOT)?.addedPackages).toHaveLength(1);
    expect(ledger("registry.index") - before).toBe(1);
  });

  test("a dependency registry's index is read once per poll across every update, and again on the next poll", async () => {
    const ROOT2 = "com.example.root2";
    const viaLibs = { [DEP]: { range: "^1.0.0", registry: "https://libs.test/" } };
    await addRegistry("libs", { [DEP]: [{ version: "1.0.0" }] });
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: viaLibs }],
      [ROOT2]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: viaLibs }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    await installFromRegistry(deps(), { id: ROOT2, version: "1.0.0" });
    const rt = runtime();
    const before = ledger("registry.index");
    await rt.deps.forcePoll();
    for (const id of [ROOT, ROOT2]) {
      expect(rt.deps.cache.get(id)?.addedPackages).toMatchObject([{ id: DEP, registry: "libs" }]);
    }
    // main once (the detection's read, reused by both plans) and libs once (shared by both plans).
    expect(ledger("registry.index") - before).toBe(2);
    // Never across polls: the next poll reads both again.
    const second = ledger("registry.index");
    await rt.deps.forcePoll();
    expect(ledger("registry.index") - second).toBe(2);
  });

  test("an update whose signature failed is not planned: its dependency is never fetched", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    // Re-published (same root key, next sequence) with a 1.2.0 whose manifests are mis-signed.
    await addRegistryAgain("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    const rt = runtime();
    const before = ledger("registry.manifest");
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.verificationStatus).toBe("signature_failed");
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toBeUndefined();
    // The root's own manifest only: nothing was asked for the dependency.
    expect(ledger("registry.manifest") - before).toBe(1);
  });

  test("a dependency whose registry is unreachable is an offline conflict", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://other.test/" } },
        },
      ],
    });
    // Added, but every request to it answers 503.
    addUnservedRegistry("other");
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0", registry: "main" });
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts).toEqual([
      {
        kind: "offline",
        id: DEP,
        parent: ROOT,
        reason: `offline_dependency_resolution:${DEP} (required by ${ROOT})`,
      },
    ]);
  });

  test("under air gap, a dependency from a remote registry is an offline conflict, never clean", async () => {
    // The source registry is a local folder (it still answers under air gap); the dependency's
    // registry is remote, so the fetch layer refuses it with ERR_REGISTRY_AIR_GAP before any
    // request — an unreachable registry, hence `offline`.
    await addRegistry(
      "main",
      {
        [ROOT]: [
          { version: "1.0.0" },
          {
            version: "1.2.0",
            dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://other.test/" } },
          },
        ],
      },
      { local: true },
    );
    await addRegistry("other", { [DEP]: [{ version: "1.0.0" }] });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    airGapped = true;
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    expect(cached?.toVersion).toBe("1.2.0");
    expect(cached?.addedPackages).toBeUndefined();
    expect(cached?.conflicts?.map((c) => c.kind)).toEqual(["offline"]);
    expect(cached?.conflicts?.[0]).toMatchObject({ kind: "offline", id: DEP, parent: ROOT });
  });
});

describe("the update approval lists what the update adds (production wiring)", () => {
  type Asked = {
    payload: Record<string, unknown>;
    packageFetches: number;
    manifestFetches: number;
  };

  /** Detects, then asks to apply ROOT@1.2.0; the owner rejects, so nothing is ever applied. */
  async function askToUpdate(): Promise<{ asked: Asked[]; result: Record<string, unknown> }> {
    _resetAutoUpdateMutexForTests();
    const rt = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmp, "extensions"),
      dataDir: join(tmp, "data"),
      fetch: fetchBag(),
      intervalHours: 24,
    });
    await rt.deps.forcePoll();
    const asked: Asked[] = [];
    const result = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: ROOT, toVersion: "1.2.0" },
      {
        ...rt.deps,
        gate: async (action) => {
          asked.push({
            payload: action.payload,
            packageFetches: ledger("registry.package"),
            manifestFetches: ledger("registry.manifest"),
          });
          return { status: "rejected" };
        },
      },
    )) as Record<string, unknown>;
    return { asked, result };
  }

  test("an update adding packages shows them in the approval before anything is fetched", async () => {
    await addRegistry("main", {
      [ROOT]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const packagesBefore = ledger("registry.package");
    // The counter is live: the root's own install downloaded its package through the ledger.
    expect(packagesBefore).toBeGreaterThan(0);
    const manifestsBefore = ledger("registry.manifest");
    const { asked, result } = await askToUpdate();
    expect(asked).toHaveLength(1);
    const p = asked[0]?.payload ?? {};
    expect(p["addedPackages"]).toMatchObject([
      { id: DEP, version: "1.0.0", registry: "main", newlyInstalled: true, kind: "extension" },
    ]);
    expect(String(p["planText"])).toStartWith("This update adds 1 package(s):\n");
    expect(String(p["planText"])).toContain(`${DEP}@1.0.0 (${ROOT} needs ^1.0.0)`);
    // Planned from verified manifests only: no package was downloaded before the owner answered.
    expect(asked[0]?.packageFetches).toBe(packagesBefore);
    expect(asked[0]?.manifestFetches).toBeGreaterThan(manifestsBefore);
    expect(result).toEqual({ applied: false, reason: "user_rejected" });
    expect(db.query("SELECT id FROM extension WHERE id = ?").get(DEP)).toBeNull();
  });

  test("the update approval shows the new connector requirement", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { [DEP]: "^1.0.0" },
          requires: { connectors: ["slack"] },
        },
      ],
      [DEP]: [{ version: "1.0.0", requires: { connectors: ["github"] } }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const { asked } = await askToUpdate();
    const p = asked[0]?.payload ?? {};
    const reqs = p["connectorRequirements"] as Array<{
      connector: string;
      state: string;
      requiredBy: string[];
    }>;
    expect(reqs.map((r) => [r.connector, r.state, r.requiredBy])).toEqual([
      ["github", "not_connected", [DEP]],
      ["slack", "not_connected", [ROOT]],
    ]);
    expect(String(p["planText"])).toContain("\nNeeds:\n  github: not connected");
  });

  test("a planning conflict refuses before the gate with update_conflicts", async () => {
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://elsewhere.test/" } },
        },
      ],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    const { asked, result } = await askToUpdate();
    expect(asked).toHaveLength(0);
    expect(result["applied"]).toBe(false);
    expect(result["reason"]).toBe("update_conflicts");
    expect(String(result["hint"])).toStartWith("update_conflicts: ");
    expect(String(result["hint"])).toContain("ERR_DEPENDENCY_REGISTRY_NOT_ADDED");
  });

  test("every conflict is reported, one update_conflicts line each, in the list and the refusal", async () => {
    const OTHER = "com.example.other";
    const PINNER = "com.example.pinner";
    await addRegistry("main", {
      [ROOT]: [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: {
            [DEP]: { range: "^1.0.0", registry: "https://elsewhere.test/" },
            [OTHER]: { range: "^1.0.0", registry: "https://another.test/" },
          },
        },
      ],
      [PINNER]: [{ version: "1.0.0", dependsOn: { [ROOT]: "~1.0.0" } }],
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
    await installFromRegistry(deps(), { id: PINNER });
    const { asked, result } = await askToUpdate();
    expect(asked).toHaveLength(0);
    expect(result["reason"]).toBe("update_conflicts");
    const lines = String(result["hint"]).split("\n");
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toStartWith("update_conflicts: ");
    // The root's own dependent first, then each unadded registry in declaration order.
    expect(lines[0]).toContain(`${ROOT}: no version satisfies ~1.0.0 (from ${PINNER})`);
    expect(lines[1]).toContain("https://elsewhere.test/");
    expect(lines[2]).toContain("https://another.test/");
    // Detection lists the same three.
    const rt = createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmp, "extensions"),
      dataDir: join(tmp, "data"),
      fetch: fetchBag(),
      intervalHours: 24,
    });
    await rt.deps.forcePoll();
    const conflicts = rt.deps.cache.get(ROOT)?.conflicts ?? [];
    expect(conflicts.map((c) => `update_conflicts: ${c.reason}`)).toEqual(lines);
  });
});

/** Re-publishes `name`'s folder with mis-signed manifests (same root key, next index sequence). */
async function addRegistryAgain(name: string, exts: Record<string, TestVersion[]>): Promise<void> {
  await buildMultiExtensionRegistry(join(tmp, name), exts, { badManifestSignature: true });
}

/** An owner registry row whose URL nothing serves (the fake network answers 503). */
function addUnservedRegistry(name: string): void {
  insertRegistry(db, {
    name,
    url: `https://${name}.test/`,
    rootKey,
    rootFingerprint: publisherKeyFingerprint(rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
}

describe("an approved update installs the packages it adds (production wiring)", () => {
  const PACK_ROOT_VERSIONS: TestVersion[] = [
    { version: "1.0.0" },
    { version: "1.2.0", starterPack: true, dependsOn: { [DEP]: "^1.0.0" } },
  ];

  function runtime() {
    return createAutoUpdateRuntime({
      db,
      vault,
      extensionsDir: join(tmp, "extensions"),
      dataDir: join(tmp, "data"),
      fetch: fetchBag(),
      intervalHours: 24,
    });
  }

  /** ROOT 1.0.0 installed from `main`, whose 1.2.0 adds DEP (unless `rootVersions` says otherwise). */
  async function installedRoot(
    rootVersions: TestVersion[] = [
      { version: "1.0.0" },
      { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } },
    ],
    extra: Record<string, TestVersion[]> = {},
  ): Promise<void> {
    await addRegistry("main", {
      [ROOT]: rootVersions,
      [DEP]: [{ version: "1.0.0" }],
      ...extra,
    });
    await installFromRegistry(deps(), { id: ROOT, version: "1.0.0" });
  }

  /** Detects, then applies ROOT@1.2.0 through `extension.update`; `beforeApply` runs at the gate. */
  async function update(beforeApply: () => void | Promise<void> = () => {}) {
    _resetAutoUpdateMutexForTests();
    const rt = runtime();
    await rt.deps.forcePoll();
    let asked = 0;
    const result = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: ROOT, toVersion: "1.2.0" },
      {
        ...rt.deps,
        gate: async () => {
          asked++;
          await beforeApply();
          return "proceed" as const;
        },
      },
    )) as Record<string, unknown>;
    return { result, asked };
  }

  /** The detected ROOT@1.2.0 update and the runtime that detected it. */
  async function detected() {
    const rt = runtime();
    await rt.deps.forcePoll();
    const cached = rt.deps.cache.get(ROOT);
    if (cached === undefined) throw new Error("no update detected");
    return { rt, cached };
  }

  function versionOf(id: string): string | undefined {
    return (
      db.query("SELECT version FROM extension WHERE id = ?").get(id) as { version: string } | null
    )?.version;
  }

  function packageRowsFor(id: string): number {
    const row = db
      .query(
        "SELECT COUNT(*) AS n FROM egress_ledger WHERE method = 'registry.package' AND payload_summary LIKE ?",
      )
      .get(`%${id}%`) as { n: number };
    return row.n;
  }

  /** The installed root's entry file: which code is on disk. */
  function rootCode(): string {
    return readFileSync(join(tmp, "extensions", ROOT, "dist", "index.js"), "utf8");
  }

  /** Re-signs `main`'s index (next sequence) after `edit`; the package files stay served. */
  function editMainIndex(
    edit: (index: { extensions: Record<string, { versions: Record<string, unknown> }> }) => void,
  ): void {
    const path = join(tmp, "main", "index.json");
    const index = JSON.parse(readFileSync(path, "utf8")) as {
      sequence: number;
      extensions: Record<string, { versions: Record<string, unknown> }>;
    };
    edit(index);
    resignIndex(path, { ...index, sequence: index.sequence + 1 });
  }

  function expectNothingAdded(): void {
    expect(versionOf(ROOT)).toBe("1.0.0");
    expect(rootCode()).toContain("1.0.0");
    expect(versionOf(DEP)).toBeUndefined();
    expect(existsSync(join(tmp, "extensions", DEP))).toBe(false);
    expect(forwardDeps(db, ROOT)).toEqual([]);
  }

  test("an approved update installs its new dependency from the registry and records the edges", async () => {
    await installedRoot();
    const packagesBefore = ledger("registry.package");
    const { result, asked } = await update();
    expect(asked).toBe(1);
    expect(result).toMatchObject({
      applied: true,
      addedPackages: [{ id: DEP, version: "1.0.0", registry: "main", kind: "extension" }],
    });
    expect(versionOf(ROOT)).toBe("1.2.0");
    expect(rootCode()).toContain("1.2.0");
    expect(versionOf(DEP)).toBe("1.0.0");
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(getExtensionSource(db, DEP)).toMatchObject({ registry: "main", channel: "stable" });
    expect(forwardDeps(db, ROOT)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
    expect(forwardDeps(db, DEP)).toEqual([]);
    // One ledgered package download per package: the root's and the dependency's.
    expect(ledger("registry.package") - packagesBefore).toBe(2);
    expect(packageRowsFor(DEP)).toBe(1);
  });

  test("an update whose new version drops a dependency reports the package it left needed by nothing", async () => {
    await installedRoot([
      { version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } },
      { version: "1.2.0" },
    ]);
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(forwardDeps(db, ROOT)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
    const { result } = await update();
    expect(result).toMatchObject({ applied: true, orphanedDependencies: [DEP] });
    expect(versionOf(ROOT)).toBe("1.2.0");
    expect(forwardDeps(db, ROOT)).toEqual([]);
    // Reported, never removed: the owner removes it.
    expect(versionOf(DEP)).toBe("1.0.0");
  });

  test("an update that keeps its dependency reports no orphan", async () => {
    await installedRoot([
      { version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } },
      { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } },
    ]);
    const { result } = await update();
    expect(result["applied"]).toBe(true);
    expect("orphanedDependencies" in result).toBe(false);
    expect(forwardDeps(db, ROOT)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
  });

  test("a dependency the plan relies on that is removed while the approval is open: cache_miss", async () => {
    await installedRoot([
      { version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } },
      { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } },
    ]);
    const { result } = await update(() => {
      // Another terminal removed (or moved) DEP while the prompt was open.
      db.run("UPDATE extension SET version = '1.1.0' WHERE id = ?", [DEP]);
    });
    expect(result).toEqual({ applied: false, reason: "cache_miss" });
    expect(versionOf(ROOT)).toBe("1.0.0");
  });

  // The POSITIVE half of "apply installs the approved set or refuses": the index changes between
  // the gate and the apply, the approved version is still listed, so the apply goes ahead and
  // installs exactly that version. The two tests after it are the refusing half.
  test("apply installs the approved set: a newer dependency version published after the gate is not taken", async () => {
    await installedRoot();
    const { result } = await update(async () => {
      // A real, signed DEP 1.1.0 lands beside the approved 1.0.0, whose files are left as they were.
      const dir = join(tmp, "main");
      const before = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as {
        extensions: Record<string, { versions: Record<string, unknown> }>;
      };
      await buildMultiExtensionRegistry(dir, { [DEP]: [{ version: "1.1.0" }] });
      editMainIndex((index) => {
        const newer = index.extensions[DEP]?.versions["1.1.0"];
        const approvedEntry = before.extensions[DEP]?.versions["1.0.0"];
        if (newer === undefined || approvedEntry === undefined) throw new Error("no dep versions");
        index.extensions = {
          ...before.extensions,
          [DEP]: { ...index.extensions[DEP], versions: { "1.0.0": approvedEntry, "1.1.0": newer } },
        };
      });
    });
    expect(result).toMatchObject({ applied: true, addedPackages: [{ id: DEP, version: "1.0.0" }] });
    expect(versionOf(DEP)).toBe("1.0.0");
    // The control: the signed index the apply re-read did list the newer 1.1.0 next to it.
    const served = JSON.parse(readFileSync(join(tmp, "main", "index.json"), "utf8")) as {
      extensions: Record<string, { versions: Record<string, unknown> }>;
    };
    expect(Object.keys(served.extensions[DEP]?.versions ?? {}).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(served.extensions[ROOT]).toBeDefined();
  });

  test("apply refuses when the approved dependency version is taken down after the gate (I48)", async () => {
    await installedRoot();
    const { result } = await update(async () => {
      const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 40);
      const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
      const s = await signTrustStatement(
        {
          kind: "extension.takedown",
          issuedAt: "2026-10-28T12:00:00Z",
          signerKey: nimbusKey,
          extensionId: DEP,
          publisherId: "acme",
          versions: ["1.0.0"],
          reason: "malware",
        },
        seed,
      );
      recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    });
    expect(result).toEqual({ applied: false, reason: "trust_blocked" });
    expect(packageRowsFor(DEP)).toBe(0);
    expectNothingAdded();
  });

  test("apply refuses when the approved dependency version is withdrawn from the index after the gate", async () => {
    await installedRoot();
    const { result } = await update(() =>
      editMainIndex((index) => {
        // The whole entry: an entry with no versions left would make the index itself invalid.
        delete index.extensions[DEP];
      }),
    );
    // The package file is still served: only the re-read index refuses it, never the resolver's memory.
    expect(existsSync(join(tmp, "main", "extensions", DEP, "1.0.0", "package.tgz"))).toBe(true);
    expect(result).toEqual({ applied: false, reason: "signature_failed" });
    expect(packageRowsFor(DEP)).toBe(0);
    expectNothingAdded();
  });

  test("a failed swap rolls back the new dependencies and keeps the old root", async () => {
    await installedRoot();
    // A file where the versions area must be a directory: the swap's first step fails.
    const prev = prevVersionsDir(join(tmp, "extensions"), ROOT);
    mkdirSync(dirname(prev), { recursive: true });
    writeFileSync(prev, "not a directory");
    const { result } = await update();
    expect(result).toEqual({ applied: false, reason: "swap_failed" });
    // The dependency was installed (downloaded) before the swap, then undone.
    expect(packageRowsFor(DEP)).toBe(1);
    expectNothingAdded();
  });

  test("a failed commit after the swap restores the old root, then rolls back the new dependencies", async () => {
    await installedRoot();
    db.run(
      "CREATE TRIGGER no_edges BEFORE INSERT ON extension_dependency BEGIN SELECT RAISE(ABORT, 'edge write refused'); END",
    );
    const { result } = await update();
    expect(result).toEqual({ applied: false, reason: "swap_failed" });
    expect(packageRowsFor(DEP)).toBe(1);
    expectNothingAdded();
    // The old version went back to the install path; it is no longer parked in prev/.
    expect(existsSync(prevVersionDir(join(tmp, "extensions"), ROOT, "1.0.0"))).toBe(false);
  });

  test("an update to a starter pack installs its members and drops the grant", async () => {
    // The row's kind column (and the pack's grant drop) needs the current schema.
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    await installedRoot(PACK_ROOT_VERSIONS);
    upsertRunGrant(db, {
      extension_id: ROOT,
      service_id: "ext_update_pack",
      version: "1.0.0",
      tree_digest: "c".repeat(64),
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    const { result } = await update();
    expect(result).toMatchObject({
      applied: true,
      addedPackages: [{ id: DEP, version: "1.0.0", kind: "extension" }],
    });
    expect(versionOf(ROOT)).toBe("1.2.0");
    expect(getExtensionKind(db, ROOT)).toBe("starter-pack");
    expect(getRunGrant(db, ROOT)).toBeNull();
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(forwardDeps(db, ROOT)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
  });

  test("an update that declares dependencies is refused when applied without an approved plan", async () => {
    await installedRoot();
    const { rt, cached } = await detected();
    await expect(rt.deps.performUpgrade(cached)).rejects.toThrow(
      /^update_conflicts: .*no approved plan/,
    );
    expectNothingAdded();
  });

  test("a plan solved from other dependencies than the re-verified manifest declares is refused", async () => {
    await installedRoot();
    const { rt, cached } = await detected();
    // The plan is solved as if 1.2.0 declared nothing; the manifest re-verified at apply declares DEP.
    const { dependsOn: _declared, ...withoutDeps } = cached;
    const plan = await rt.deps.planUpdate(withoutDeps);
    expect(plan.addedPackages).toEqual([]);
    await expect(rt.deps.performUpgrade(cached, plan)).rejects.toThrow(
      /^update_conflicts: .*not the ones the approved plan was solved from/,
    );
    expectNothingAdded();
  });

  test("a package installed by someone else since the plan is refused and left in place", async () => {
    await installedRoot();
    const { rt, cached } = await detected();
    const plan = await rt.deps.planUpdate(cached);
    expect(plan.addedPackages.map((p) => p.id)).toEqual([DEP]);
    await installFromRegistry(deps(), { id: DEP });
    await expect(rt.deps.performUpgrade(cached, plan)).rejects.toThrow(
      /^update_conflicts: .*ERR_REGISTRY_INSTALL_REFUSED/,
    );
    expect(versionOf(ROOT)).toBe("1.0.0");
    // The owner's own install of DEP is untouched by the refusal.
    expect(versionOf(DEP)).toBe("1.0.0");
    expect(isInstalledAsDependency(db, DEP)).toBe(false);
  });

  test("a package that appears while the dependencies are staged is an install race, not a signature failure", async () => {
    await installedRoot();
    const depDir = join(tmp, "extensions", DEP);
    const { result } = await update(() => {
      // After the up-front existence check: DEP's directory appears while its package downloads.
      beforeServe = (url) => {
        if (url.includes(`/extensions/${DEP}/`) && url.endsWith("/package.tgz")) {
          mkdirSync(depDir, { recursive: true });
        }
      };
    });
    expect(packageRowsFor(DEP)).toBe(1);
    expect(result).toEqual({ applied: false, reason: "update_conflicts" });
    expect(versionOf(ROOT)).toBe("1.0.0");
    expect(versionOf(DEP)).toBeUndefined();
    // Not this install's to remove: it never created that directory.
    expect(existsSync(depDir)).toBe(true);
  });

  test("a dependent that came to pin the root since the plan refuses the apply", async () => {
    const OTHER = "com.example.other";
    await installedRoot(undefined, {
      [OTHER]: [{ version: "1.0.0", dependsOn: { [ROOT]: "~1.0.0" } }],
    });
    const { rt, cached } = await detected();
    const plan = await rt.deps.planUpdate(cached);
    await installFromRegistry(deps(), { id: OTHER });
    await expect(rt.deps.performUpgrade(cached, plan)).rejects.toThrow(/^update_conflicts: /);
    expect(versionOf(ROOT)).toBe("1.0.0");
    expect(versionOf(DEP)).toBeUndefined();
  });
});
