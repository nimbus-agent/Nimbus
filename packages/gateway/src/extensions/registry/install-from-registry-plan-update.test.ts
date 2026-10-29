/**
 * `planUpdate` (extension dependencies PR 5): an update's new dependencies are solved through the
 * same registry-scoped resolver a registry install uses (I44), so a dependency the registries carry
 * becomes an added package, while a range an installed dependent pins, or a registry the owner has
 * not added, is a conflict. The daemon's detection (`createAutoUpdateRuntime`, the production
 * wiring) caches what the plan found.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { createAutoUpdateRuntime } from "../auto-update-init.ts";
import { DependencyConflictError } from "../dependency-errors.ts";
import type { ExtensionManifestForSolver } from "../dependency-types.ts";
import {
  buildMultiExtensionRegistry,
  type TestVersion,
} from "./__fixtures__/build-test-registry.ts";
import {
  type InstallFromRegistryDeps,
  installFromRegistry,
  planUpdate,
} from "./install-from-registry.ts";
import { insertRegistry } from "./registry-store.ts";

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
});

afterEach(() => {
  db.close();
  rmDirWithRetry(tmp);
});

async function addRegistry(name: string, exts: Record<string, TestVersion[]>): Promise<void> {
  const dir = join(tmp, name);
  rootKey = (await buildMultiExtensionRegistry(dir, exts)).rootKey;
  served.set(name, dir);
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

function fetchBag(): InstallFromRegistryDeps["fetch"] {
  return {
    fetchFn: async (url) => {
      const u = new URL(url);
      const dir = served.get(u.hostname.replace(/\.test$/, ""));
      if (dir === undefined) return new Response("down", { status: 503 });
      try {
        return new Response(readFileSync(join(dir, ...u.pathname.split("/").filter(Boolean))));
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
    enforceAirGap: () => false,
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
});
