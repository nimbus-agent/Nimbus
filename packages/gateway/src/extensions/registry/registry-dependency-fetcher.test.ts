import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publisherKeyFingerprint,
  RegistryError,
  signTrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import { DependencyConflictError, OfflineDependencyResolutionError } from "../dependency-errors.ts";
import { resolveClosure } from "../dependency-graph.ts";
import {
  type ExtensionManifestForSolver,
  type InstalledForSolver,
  type InstallPlan,
  sourceKey,
} from "../dependency-types.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import {
  buildMultiExtensionRegistry,
  type TestVersion,
} from "./__fixtures__/build-test-registry.ts";
import { BUILTIN_REGISTRY_NAME, type BuiltinRegistryConfig } from "./builtin-registry.ts";
import { type InstallFromRegistryDeps, installFromRegistry } from "./install-from-registry.ts";
import {
  createRegistryDependencyResolver,
  type RegistryDependencyResolver,
} from "./registry-dependency-fetcher.ts";
import { sha256Hex } from "./registry-manifest.ts";
import { getRegistry, insertRegistry } from "./registry-store.ts";

const NOW = Date.parse("2026-10-28T12:00:00Z");
const ROOT_ID = "com.example.root";

let db: Database;
let tmp: string;
let vault: MockVault;
let rootKey: string;
/** Remote registries are served from these folders by a fake `fetchFn`: `https://<name>.test/`. */
const served = new Map<string, string>();
/** Whether the fake gateway is air-gapped: remote registries are then refused before any request. */
let airGapped = false;
/** The built-in registry these deps carry (none unless a test serves one). */
let builtin: BuiltinRegistryConfig | null = null;
/** Every request the harness `fetchFn` was asked to make. */
let fetchCalls = 0;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 78);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-depfetch-"));
  vault = new MockVault();
  served.clear();
  airGapped = false;
  builtin = null;
  fetchCalls = 0;
});

afterEach(() => {
  db.close();
  rmDirWithRetry(tmp);
});

/**
 * A registry carrying `exts`, added as an owner registry: remote (`https://<name>.test/`, served
 * from its folder) unless `local`, whose URL is the folder itself.
 */
async function addRegistry(
  name: string,
  exts: Record<string, TestVersion[]>,
  extra: Parameters<typeof buildMultiExtensionRegistry>[2] = {},
  { local = false }: { local?: boolean } = {},
): Promise<string> {
  const dir = join(tmp, name);
  rootKey = (await buildMultiExtensionRegistry(dir, exts, extra)).rootKey;
  if (!local) served.set(name, dir);
  insertRegistry(db, {
    name,
    url: local ? dir : `https://${name}.test/`,
    rootKey,
    rootFingerprint: publisherKeyFingerprint(rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
  return dir;
}

function deps(): InstallFromRegistryDeps {
  return {
    db,
    extensionsDir: join(tmp, "extensions"),
    vault,
    fetch: {
      fetchFn: async (url) => {
        fetchCalls++;
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
      builtin,
    },
    approve: async () => true,
  };
}

function ledger(method?: string): number {
  const row =
    method === undefined
      ? db.query("SELECT COUNT(*) AS n FROM egress_ledger").get()
      : db.query("SELECT COUNT(*) AS n FROM egress_ledger WHERE method = ?").get(method);
  return (row as { n: number }).n;
}

function resolverFor(name: string, channel: "stable" | "beta" = "stable") {
  const reg = getRegistry(db, name);
  if (reg === undefined) throw new Error(`no registry ${name}`);
  return createRegistryDependencyResolver(deps(), { reg, channel });
}

function rootNeeding(
  dependsOn: ExtensionManifestForSolver["dependsOn"],
): ExtensionManifestForSolver {
  return { id: ROOT_ID, version: "1.0.0", ...(dependsOn === undefined ? {} : { dependsOn }) };
}

function solve(
  r: RegistryDependencyResolver,
  root: ExtensionManifestForSolver,
  installed: ReadonlyMap<string, InstalledForSolver> = new Map(),
): Promise<InstallPlan> {
  return resolveClosure(root, r.rootSource, r.fetcher, { installed, activeConstraints: new Map() });
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const ONE: TestVersion[] = [{ version: "1.0.0" }];

describe("createRegistryDependencyResolver (phase 1: verified manifests)", () => {
  test("nothing is read for a package with no dependencies", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    const plan = await solve(r, rootNeeding(undefined));
    expect(plan.nodes.map((n) => n.id)).toEqual([ROOT_ID]);
    expect(ledger()).toBe(0);
  });

  test("an installed same-source dependency is read from disk", async () => {
    await addRegistry("main", { "com.dep": ONE });
    await installFromRegistry(deps(), { id: "com.dep" });
    const before = { manifest: ledger("registry.manifest"), all: ledger() };
    const r = resolverFor("main");
    const source = sourceKey("main", publisherKeyFingerprint(rootKey));
    const plan = await solve(
      r,
      rootNeeding({ "com.dep": { range: "^1.0.0" } }),
      new Map([["com.dep", { version: "1.0.0", source }]]),
    );
    expect(plan.nodes.find((n) => n.id === "com.dep")).toMatchObject({
      version: "1.0.0",
      newlyInstalled: false,
      source,
    });
    expect(ledger("registry.manifest")).toBe(before.manifest);
    expect(ledger()).toBe(before.all);
    expect(r.verified("com.dep", "1.0.0")).toBeUndefined();
  });

  test("each registry's index is read once per resolve", async () => {
    await addRegistry("main", { "com.a": ONE, "com.b": ONE });
    const r = resolverFor("main");
    const plan = await solve(
      r,
      rootNeeding({ "com.a": { range: "^1.0.0" }, "com.b": { range: "^1.0.0" } }),
    );
    expect(plan.nodes.map((n) => n.id).sort()).toEqual([ROOT_ID, "com.a", "com.b"].sort());
    expect(ledger("registry.index")).toBe(1);
    expect(ledger("registry.manifest")).toBe(2);
    expect(r.verified("com.a", "1.0.0")?.reg.name).toBe("main");
    expect(r.verified("com.b", "1.0.0")?.publisherKey).toBeString();
  });

  test("the root's already-verified index is reused, not read again", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const reg = getRegistry(db, "main");
    if (reg === undefined) throw new Error("no registry");
    const { fetchVerifiedIndex } = await import("./registry-fetch.ts");
    const index = await fetchVerifiedIndex({ ...deps().fetch, db }, reg);
    const after = ledger("registry.index");
    const r = createRegistryDependencyResolver(deps(), { reg, channel: "stable", index });
    await solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } }));
    expect(ledger("registry.index")).toBe(after);
  });

  test("a dependency naming another added registry is fetched from it", async () => {
    await addRegistry("main", { "com.unrelated": ONE });
    await addRegistry("other", { "com.dep": ONE });
    const r = resolverFor("main");
    const plan = await solve(
      r,
      rootNeeding({ "com.dep": { range: "^1.0.0", registry: "https://other.test/" } }),
    );
    const dep = plan.nodes.find((n) => n.id === "com.dep");
    expect(dep?.source).toBe(sourceKey("other", publisherKeyFingerprint(rootKey)));
    expect(r.verified("com.dep", "1.0.0")?.reg.name).toBe("other");
  });

  test("a beta-only dependency of a stable install is unsatisfiable", async () => {
    await addRegistry("main", { "com.dep": [{ version: "2.0.0", channel: "beta" }] });
    const stable = resolverFor("main");
    expect(await stable.fetcher.listVersions("com.dep", stable.rootSource)).toEqual([]);
    const e = await rejectionOf(solve(stable, rootNeeding({ "com.dep": { range: "^2.0.0" } })));
    expect(e).toBeInstanceOf(DependencyConflictError);
    const beta = resolverFor("main", "beta");
    expect(await beta.fetcher.listVersions("com.dep", beta.rootSource)).toEqual(["2.0.0"]);
  });

  test("an id the registry does not carry lists no versions", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    expect(await r.fetcher.listVersions("com.absent", r.rootSource)).toEqual([]);
  });

  test("a taken-down dependency version falls back to the clean one below it", async () => {
    await addRegistry("main", { "com.dep": [{ version: "1.0.9" }, { version: "1.1.0" }] });
    const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
    const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NIMBUS_KEY,
        extensionId: "com.dep",
        publisherId: "acme",
        versions: ["1.1.0"],
        reason: "malware",
      },
      NIMBUS_SEED,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: NIMBUS_KEY }, 1);
    const r = resolverFor("main");
    expect(await r.fetcher.listVersions("com.dep", r.rootSource)).toEqual(["1.0.9"]);
    const plan = await solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } }));
    expect(plan.nodes.find((n) => n.id === "com.dep")?.version).toBe("1.0.9");
    expect(ledger("registry.manifest")).toBe(1);
  });

  test("a dependency manifest that fails its signature is refused before staging", async () => {
    await addRegistry("main", { "com.dep": ONE }, { badManifestSignature: true });
    const r = resolverFor("main");
    const e = await rejectionOf(solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } })));
    // A security refusal, never reported as "you are offline".
    expect(e).not.toBeInstanceOf(OfflineDependencyResolutionError);
    expect(e).toBeInstanceOf(RegistryError);
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_SIGNATURE_INVALID");
    expect(r.verified("com.dep", "1.0.0")).toBeUndefined();
    expect(ledger("registry.package")).toBe(0);
  });

  test("a dependency whose publisher key conflicts with the Vault is refused", async () => {
    await addRegistry("main", { "com.dep": ONE });
    await writePublisherKey(
      vault,
      "acme",
      nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey,
    );
    const r = resolverFor("main");
    const e = await rejectionOf(solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } })));
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT");
    expect(r.verified("com.dep", "1.0.0")).toBeUndefined();
  });

  test("a pack can be a dependency", async () => {
    await addRegistry("main", {
      "com.dep": [{ version: "1.0.0", starterPack: true, dependsOn: { "com.leaf": "^1.0.0" } }],
      "com.leaf": ONE,
    });
    const r = resolverFor("main");
    const plan = await solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } }));
    // Topological: the pack's member, then the pack, then the root that needs it.
    expect(plan.nodes.map((n) => n.id)).toEqual(["com.leaf", "com.dep", ROOT_ID]);
    expect(r.verified("com.dep", "1.0.0")?.manifest.kind).toBe("starter-pack");
    expect(r.verified("com.leaf", "1.0.0")).toBeDefined();
  });
});

describe("createRegistryDependencyResolver (sources it did not meet itself)", () => {
  test("a local-folder node names no registry and lists no versions", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    expect(r.fetcher.targetSource(null, "com.dep", { range: "^1.0.0" })).toBeNull();
    expect(await r.fetcher.listVersions("com.dep", null)).toEqual([]);
    const e = await rejectionOf(r.fetcher.fetchManifest("com.dep", "1.0.0", null));
    expect((e as RegistryError).code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    expect(ledger()).toBe(0);
  });

  test("an installed node's recorded registry is looked up by name and fingerprint", async () => {
    await addRegistry("main", { "com.unrelated": ONE });
    await addRegistry("other", { "com.dep": ONE });
    const otherSource = sourceKey("other", publisherKeyFingerprint(rootKey));
    const r = resolverFor("main");
    expect(r.registryUrl(otherSource)).toBeNull();
    expect(await r.fetcher.listVersions("com.dep", otherSource)).toEqual(["1.0.0"]);
    expect(r.registryUrl(otherSource)).toBe("https://other.test/");
  });

  test("a recorded registry that was removed or re-pinned is refused", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    for (const source of [sourceKey("gone", "ab".repeat(32)), sourceKey("main", "cd".repeat(32))]) {
      const e = await rejectionOf(r.fetcher.listVersions("com.dep", source));
      expect((e as RegistryError).code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    }
  });

  test("a version the index does not list is not found", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    const e = await rejectionOf(r.fetcher.fetchManifest("com.dep", "9.9.9", r.rootSource));
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_VERSION_NOT_FOUND");
  });
});

describe("createRegistryDependencyResolver (installed manifests are re-checked)", () => {
  function installedRow(id: string): { install_path: string } {
    return db.query("SELECT install_path FROM extension WHERE id = ?").get(id) as {
      install_path: string;
    };
  }

  async function installDep(): Promise<{ r: RegistryDependencyResolver; manifestPath: string }> {
    await addRegistry("main", { "com.dep": ONE });
    await installFromRegistry(deps(), { id: "com.dep" });
    const manifestPath = join(installedRow("com.dep").install_path, "nimbus.extension.json");
    return { r: resolverFor("main"), manifestPath };
  }

  test("an installed manifest whose bytes changed is refused", async () => {
    const { r, manifestPath } = await installDep();
    writeFileSync(manifestPath, `${readFileSync(manifestPath, "utf8")}\n`);
    const e = await rejectionOf(r.fetcher.fetchManifest("com.dep", "1.0.0", r.rootSource));
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_MANIFEST_INVALID");
    expect((e as RegistryError).message).toContain("no longer matches");
  });

  test("an installed copy with no manifest is refused", async () => {
    const { r, manifestPath } = await installDep();
    rmSync(manifestPath);
    const e = await rejectionOf(r.fetcher.fetchManifest("com.dep", "1.0.0", r.rootSource));
    expect((e as RegistryError).message).toContain("has no manifest");
  });

  test("an installed manifest that matches its hash but does not parse is refused", async () => {
    const { r, manifestPath } = await installDep();
    const bytes = Buffer.from("{ not json");
    writeFileSync(manifestPath, bytes);
    db.run("UPDATE extension SET manifest_hash = ? WHERE id = ?", [sha256Hex(bytes), "com.dep"]);
    const e = await rejectionOf(r.fetcher.fetchManifest("com.dep", "1.0.0", r.rootSource));
    expect((e as RegistryError).message).toContain("has an unreadable manifest");
  });

  test("a locally installed copy satisfies a node that names no registry", async () => {
    const { r } = await installDep();
    db.run(
      "UPDATE extension SET source_registry = NULL, source_root_fingerprint = NULL WHERE id = ?",
      ["com.dep"],
    );
    expect(await r.fetcher.fetchManifest("com.dep", "1.0.0", null)).toMatchObject({
      id: "com.dep",
      version: "1.0.0",
    });
    expect(ledger("registry.manifest")).toBe(1);
  });
});

describe("createRegistryDependencyResolver under air gap", () => {
  const DEP = "com.dep";

  /** The built-in registry, served remotely at `https://official.test/`, carrying `exts`. */
  async function serveBuiltin(exts: Record<string, TestVersion[]>): Promise<void> {
    const dir = join(tmp, "official");
    const built = await buildMultiExtensionRegistry(dir, exts);
    served.set("official", dir);
    builtin = { url: "https://official.test/", rootKey: built.rootKey };
  }

  /** A root in a LOCAL owner registry (it answers under air gap) needing DEP from the official one. */
  async function addLocalRoot(): Promise<void> {
    await addRegistry(
      "main",
      {
        [ROOT_ID]: [
          {
            version: "1.0.0",
            dependsOn: { [DEP]: { range: "^1.0.0", registry: "nimbus-official" } },
          },
        ],
      },
      {},
      { local: true },
    );
  }

  test("an installed official dependency is reused with zero requests", async () => {
    await serveBuiltin({ [DEP]: ONE });
    await installFromRegistry(deps(), { id: DEP, registry: BUILTIN_REGISTRY_NAME });
    await addLocalRoot();
    airGapped = true;
    const before = ledger();
    fetchCalls = 0;
    const installed = await installFromRegistry(deps(), { id: ROOT_ID, registry: "main" });
    expect(installed).toMatchObject({ id: ROOT_ID, version: "1.0.0" });
    expect(ledger()).toBe(before);
    expect(fetchCalls).toBe(0);
    const row = db.query("SELECT version FROM extension WHERE id = ?").get(ROOT_ID);
    expect(row).toEqual({ version: "1.0.0" });
  });

  test("an official dependency that is not installed is refused as air gap, never offline", async () => {
    await serveBuiltin({ [DEP]: ONE });
    await addLocalRoot();
    airGapped = true;
    const e = await rejectionOf(installFromRegistry(deps(), { id: ROOT_ID, registry: "main" }));
    expect(e).toBeInstanceOf(RegistryError);
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_AIR_GAP");
    expect(e).not.toBeInstanceOf(OfflineDependencyResolutionError);
    expect(ledger()).toBe(0);
  });

  test("a dependency installed from another registry is still a source mismatch", async () => {
    await serveBuiltin({ [DEP]: ONE });
    await addRegistry("other", { [DEP]: ONE });
    await installFromRegistry(deps(), { id: DEP, registry: "other" });
    await addLocalRoot();
    airGapped = true;
    const before = ledger();
    fetchCalls = 0;
    const e = await rejectionOf(installFromRegistry(deps(), { id: ROOT_ID, registry: "main" }));
    expect((e as RegistryError).code).toBe("ERR_DEPENDENCY_SOURCE_MISMATCH");
    expect(ledger()).toBe(before);
    expect(fetchCalls).toBe(0);
  });

  test("an air-gapped owner registry refuses with the air-gap code, not as offline", async () => {
    await addRegistry("main", { [DEP]: ONE });
    airGapped = true;
    const e = await rejectionOf(
      solve(resolverFor("main"), rootNeeding({ [DEP]: { range: "^1.0.0" } })),
    );
    expect(e).toBeInstanceOf(RegistryError);
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_AIR_GAP");
    expect(e).not.toBeInstanceOf(OfflineDependencyResolutionError);
    expect(ledger()).toBe(0);
  });
});

describe("RegistryDependencyResolver.stage (phase 2: packages, after approval)", () => {
  test("stage verifies each package against the index and extracts it", async () => {
    await addRegistry("main", { "com.a": ONE, "com.b": ONE });
    const r = resolverFor("main");
    await solve(r, rootNeeding({ "com.a": { range: "^1.0.0" }, "com.b": { range: "^1.0.0" } }));
    expect(ledger("registry.package")).toBe(0);
    const staged = await r.stage(
      [
        { id: "com.a", version: "1.0.0" },
        { id: "com.b", version: "1.0.0" },
      ],
      join(tmp, "stage"),
    );
    expect(staged.map((s) => s.id)).toEqual(["com.a", "com.b"]);
    for (const s of staged) {
      const m = JSON.parse(readFileSync(join(s.sourceRoot, "nimbus.extension.json"), "utf8"));
      expect(m.id).toBe(s.id);
      expect(existsSync(join(s.sourceRoot, "dist", "index.js"))).toBe(true);
    }
    expect(staged[0]?.sourceRoot).not.toBe(staged[1]?.sourceRoot);
    expect(ledger("registry.package")).toBe(2);
  });

  test("stage refuses a package whose bytes differ from the signed hash", async () => {
    const dir = await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    await solve(r, rootNeeding({ "com.dep": { range: "^1.0.0" } }));
    const p = join(dir, "extensions", "com.dep", "1.0.0", "package.tgz");
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(p, bytes);
    const e = await rejectionOf(r.stage([{ id: "com.dep", version: "1.0.0" }], join(tmp, "stage")));
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_HASH_MISMATCH");
  });

  test("stage refuses a node phase 1 never verified", async () => {
    await addRegistry("main", { "com.dep": ONE });
    const r = resolverFor("main");
    const e = await rejectionOf(r.stage([{ id: "com.dep", version: "1.0.0" }], join(tmp, "stage")));
    expect(e).toBeInstanceOf(RegistryError);
    expect(ledger()).toBe(0);
  });
});
