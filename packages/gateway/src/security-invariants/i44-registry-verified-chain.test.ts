import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { buildTestRegistry } from "../extensions/registry/__fixtures__/build-test-registry.ts";
import { LocalIndex } from "../index/local-index.ts";
import { encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";

const signTrustStatementDyn = async (
  s: import("@nimbus-dev/registry-format").UnsignedTrustStatement,
  seed: Uint8Array,
) => (await import("@nimbus-dev/registry-format")).signTrustStatement(s, seed);

const readExt = async (rel: string) =>
  stripComments(await read(`packages/gateway/src/extensions/${rel}`));
describe("I44 — registry-sourced extension code arrives only through the verified chain, from its source registry", () => {
  // Real local-folder registries built by the shared fixture, a real migrated database, the real
  // installer and the real update runtime. A local registry makes no network request, so nothing
  // here needs a fetcher; the remote transport is covered by registry-fetch's own tests.
  const ID = "com.example.i44";
  const NO_NETWORK = {
    fetchFn: () => Promise.reject(new Error("no network in the I44 tests")),
    enforceAirGap: () => false,
    now: () => Date.now(),
    production: false,
    builtin: null,
  };
  const roots: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  async function setup(registries: Record<string, string[]>) {
    const { buildTestRegistry } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const { insertRegistry } = await import("../extensions/registry/registry-store.ts");
    const { publisherKeyFingerprint } = await import("@nimbus-dev/registry-format");
    const { MockVault } = await import("../vault/mock.ts");
    const root = mkdtempSync(join(tmpdir(), "nimbus-i44-"));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    const dirs = new Map<string, string>();
    for (const [name, versions] of Object.entries(registries)) {
      const dir = join(root, `registry-${name}`);
      const built = await buildTestRegistry(dir, {
        id: ID,
        versions: versions.map((version) => ({ version })),
      });
      insertRegistry(db, {
        name,
        url: dir,
        rootKey: built.rootKey,
        rootFingerprint: publisherKeyFingerprint(built.rootKey),
        lastSequence: 0,
        lastGeneratedAt: "2026-10-01T00:00:00Z",
        addedAt: 1,
        lastIndexSha256: null,
      });
      dirs.set(name, dir);
    }
    const dirOf = (name: string): string => {
      const d = dirs.get(name);
      if (d === undefined) throw new Error(`no registry folder ${name}`);
      return d;
    };
    return { db, root, dirOf, vault: new MockVault(), extensionsDir: join(root, "extensions") };
  }

  type Setup = Awaited<ReturnType<typeof setup>>;

  async function install(s: Setup, req: { id: string; registry?: string; version?: string }) {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    let asked = 0;
    const result = installFromRegistry(
      {
        db: s.db,
        extensionsDir: s.extensionsDir,
        vault: s.vault,
        fetch: NO_NETWORK,
        approve: async () => {
          asked++;
          return true;
        },
      },
      req,
    );
    return { result, asked: () => asked };
  }

  async function refusalOf(p: Promise<unknown>): Promise<string> {
    const { RegistryError } = await import("@nimbus-dev/registry-format");
    const settled = await p.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(settled).toBeInstanceOf(RegistryError);
    const e = settled as InstanceType<typeof RegistryError>;
    // `<code> <message>`: a registry that fails verification surfaces its own verification code.
    return `${e.code} ${e.message}`;
  }

  function installedIds(db: Database): string[] {
    return (db.query("SELECT id FROM extension").all() as Array<{ id: string }>).map((r) => r.id);
  }

  function installedVersion(db: Database): string | undefined {
    return (
      db.query("SELECT version FROM extension WHERE id = ?").get(ID) as { version: string } | null
    )?.version;
  }

  async function runtimeFor(s: Setup) {
    const { createAutoUpdateRuntime } = await import("../extensions/auto-update-init.ts");
    return createAutoUpdateRuntime({
      db: s.db,
      vault: s.vault,
      extensionsDir: s.extensionsDir,
      dataDir: join(s.root, "data"),
      fetch: NO_NETWORK,
      intervalHours: 24,
    });
  }

  test("behavioural: an index edited without the root key's signature refuses the install; nothing is asked or installed", async () => {
    const s = await setup({ main: ["1.0.0"] });
    const indexPath = join(s.dirOf("main"), "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      extensions: Record<string, { versions: Record<string, { packageSha256: string }> }>;
    };
    const v = index.extensions[ID]?.versions["1.0.0"];
    if (v === undefined) throw new Error("fixture lacks 1.0.0");
    v.packageSha256 = "0".repeat(64);
    writeFileSync(indexPath, JSON.stringify(index));
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(
      /^ERR_REGISTRY_SIGNATURE_INVALID .*main: failed verification/,
    );
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
  });

  test("behavioural: a package byte the signed index does not cover refuses the install before the owner is asked", async () => {
    const s = await setup({ main: ["1.0.0"] });
    const pkg = join(s.dirOf("main"), "extensions", ID, "1.0.0", "package.tgz");
    const bytes = new Uint8Array(await readFile(pkg));
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(pkg, bytes);
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(/^ERR_REGISTRY_HASH_MISMATCH /);
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
  });

  test("behavioural: a manifest byte the signed index does not cover refuses the install before the owner is asked", async () => {
    const s = await setup({ main: ["1.0.0"] });
    const manifest = join(s.dirOf("main"), "extensions", ID, "1.0.0", "manifest.json");
    const bytes = new Uint8Array(await readFile(manifest));
    // A byte inside the JSON (not the last, which could be a newline the parser ignores).
    const at = Math.floor(bytes.length / 2);
    bytes[at] = (bytes[at] ?? 0) ^ 0x01;
    writeFileSync(manifest, bytes);
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(/^ERR_REGISTRY_HASH_MISMATCH .*manifest/);
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
  });

  test("behavioural: an index signed by a key other than the pinned root, or with a lower sequence, refuses", async () => {
    const { getRegistry } = await import("../extensions/registry/registry-store.ts");
    const { resignIndex } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const s = await setup({ main: ["1.0.0"] });
    // Pin a different root key than the one the folder is signed with: the pin is never replaced.
    const other = encodeBase64(generateEd25519Keypair().pubkey);
    s.db.run("UPDATE extension_registry SET root_key = ? WHERE name = 'main'", [other]);
    expect(await refusalOf((await install(s, { id: ID })).result)).toMatch(
      /^ERR_REGISTRY_ROOT_KEY_CHANGED .*main: failed verification/,
    );
    expect(getRegistry(s.db, "main")?.rootKey).toBe(other);
    expect(installedIds(s.db)).toEqual([]);
    // Anti-rollback: a sequence older than the last one seen refuses.
    const s2 = await setup({ main: ["1.0.0"] });
    s2.db.run("UPDATE extension_registry SET last_sequence = 5 WHERE name = 'main'");
    const indexPath = join(s2.dirOf("main"), "index.json");
    resignIndex(indexPath, {
      ...(JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>),
      sequence: 4,
    });
    expect(await refusalOf((await install(s2, { id: ID })).result)).toMatch(
      /^ERR_REGISTRY_ROLLBACK .*main: failed verification/,
    );
    expect(installedIds(s2.db)).toEqual([]);
  });

  test("behavioural: an index re-served at an accepted sequence with different content refuses the install; nothing is asked or installed", async () => {
    const { getRegistry } = await import("../extensions/registry/registry-store.ts");
    const { fetchVerifiedIndex } = await import("../extensions/registry/registry-fetch.ts");
    const { resignIndex } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const s = await setup({ main: ["1.0.0"] });
    const row = getRegistry(s.db, "main");
    if (row === undefined) throw new Error("registry row missing");
    // The gateway accepts the index once: its sequence AND the document at it are now the floor.
    const accepted = await fetchVerifiedIndex({ ...NO_NETWORK, db: s.db }, row);
    expect(getRegistry(s.db, "main")?.lastIndexSha256).toMatch(/^[0-9a-f]{64}$/);
    // A force-pushed gh-pages: a validly signed, DIFFERENT index at that same sequence.
    const indexPath = join(s.dirOf("main"), "index.json");
    resignIndex(indexPath, {
      ...(JSON.parse(await readFile(indexPath, "utf8")) as Record<string, unknown>),
      sequence: accepted.sequence,
      generatedAt: "2026-10-30T00:00:00Z",
    });
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(
      /^ERR_REGISTRY_EQUIVOCATION .*main: failed verification/,
    );
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
  });

  test("behavioural: a bare id carried by two registries is refused, never prioritised", async () => {
    const { getExtensionSource } = await import("../extensions/registry/registry-store.ts");
    const s = await setup({ alpha: ["1.0.0"], beta: ["1.0.0"] });
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(/^ERR_REGISTRY_AMBIGUOUS .*alpha, beta/);
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
    // Naming the registry resolves it, and the install records THAT registry as the source.
    await (await install(s, { id: ID, registry: "beta" })).result;
    expect(getExtensionSource(s.db, ID)?.registry).toBe("beta");
  });

  test("behavioural: a bare id is refused while another registry cannot be read — never prioritised by reachability", async () => {
    const { getExtensionSource } = await import("../extensions/registry/registry-store.ts");
    const s = await setup({ alpha: ["1.0.0"], beta: ["1.0.0"] });
    // beta carries the same id but cannot be reached this call; alpha alone would resolve it.
    rmSync(s.dirOf("beta"), { recursive: true, force: true });
    const run = await install(s, { id: ID });
    expect(await refusalOf(run.result)).toMatch(
      /^ERR_REGISTRY_AMBIGUOUS .*beta: unreachable.*--registry <name>/,
    );
    expect(run.asked()).toBe(0);
    expect(installedIds(s.db)).toEqual([]);
    // Naming the reachable registry is unaffected.
    await (await install(s, { id: ID, registry: "alpha" })).result;
    expect(getExtensionSource(s.db, ID)?.registry).toBe("alpha");
  });

  test("behavioural: a newer version in a registry that is not the source is never offered", async () => {
    // Installed from `main` (1.0.0 only); `other` carries 9.0.0 of the same id under the same root key.
    const { buildTestRegistry } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const s = await setup({ main: ["1.0.0"], other: ["1.0.0", "9.0.0"] });
    await (await install(s, { id: ID, registry: "main" })).result;
    const runtime = await runtimeFor(s);
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.list()).toEqual([]);
    // Positive control: the same runtime DOES offer a newer version the source itself publishes.
    await buildTestRegistry(s.dirOf("main"), {
      id: ID,
      versions: [{ version: "1.0.0" }, { version: "2.0.0" }],
    });
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.list().map((u) => [u.toVersion, u.sourceRegistry])).toEqual([
      ["2.0.0", "main"],
    ]);
  });

  test("behavioural: a source registry re-pinned after detection — apply refuses and the update is no longer offered", async () => {
    const s = await setup({ main: ["1.0.0", "2.0.0"] });
    await (await install(s, { id: ID, version: "1.0.0" })).result;
    const runtime = await runtimeFor(s);
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(ID);
    if (cached === undefined) throw new Error("no update detected");
    // The same name now holds a different root fingerprint than the one the extension came from.
    s.db.run("UPDATE extension_registry SET root_fingerprint = ? WHERE name = 'main'", [
      "f".repeat(32),
    ]);
    const settled = await runtime.deps.performUpgrade(cached).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(settled).toBeInstanceOf(Error);
    expect((settled as Error).message).toMatch(/^source_registry_changed: /);
    expect(installedVersion(s.db)).toBe("1.0.0");
    await runtime.deps.forcePoll();
    expect(runtime.deps.cache.list()).toEqual([]);
  });

  test("source pin: install-from-registry resolves through verified indexes, checks the package hash and the I16 signature, then installs", async () => {
    const src = stripComments(
      await read("packages/gateway/src/extensions/registry/install-from-registry.ts"),
    );
    // Each function's body, bounded at the next top-level export, so a later function cannot
    // satisfy another's order checks.
    const bodyOf = (code: string, header: string): string => {
      const at = code.indexOf(header);
      expect(at, header).toBeGreaterThan(-1);
      const next = code.indexOf("\nexport ", at + 1);
      return code.slice(at, next === -1 ? undefined : next);
    };
    // (1) The composition: installFromRegistry fetches-and-verifies, THEN installs that package.
    const compose = bodyOf(src, "export async function installFromRegistry(");
    const composeFetchAt = compose.indexOf("const pkg = await fetchVerifiedRegistryPackage(");
    const composeInstallAt = compose.indexOf("await installVerifiedRegistryPackage(deps, shown,");
    expect(composeFetchAt).toBeGreaterThan(-1);
    expect(composeInstallAt).toBeGreaterThan(composeFetchAt);
    // (2) The fetch half: resolve through verified indexes, then the manifest, the package hash, the
    // I16 signature and the Vault key check, ALL before a byte is written or extracted and before
    // the verified package is handed back.
    // The verified chain install shares with an author's clone (`fetchVerifiedPackageBytes`): the
    // installed-id refusal comes BEFORE it, the key decision and extraction AFTER it.
    const fetchBody = bodyOf(src, "export async function fetchVerifiedRegistryPackage(");
    const installedAt = fetchBody.indexOf('"ERR_REGISTRY_ALREADY_INSTALLED"');
    const sharedAt = fetchBody.indexOf("await fetchVerifiedPackageBytes(fetchDeps, deps.db, req)");
    const shared = bodyOf(src, "export async function fetchVerifiedPackageBytes(");
    const resolveAt = shared.indexOf("await resolveRegistryEntry(");
    const blockedAt = shared.indexOf("assertNotBlocked(db, subjectAt(version));");
    const manifestAt = shared.indexOf("await fetchRegistryManifest(");
    // The package fetch refuses bytes the index did not sign, and extraction writes the first byte;
    // both live in registry-package-stage.ts, shared with the dependency resolver (pinned below).
    const shaAt = shared.indexOf(
      "await fetchHashedPackage(fetchDeps, reg, req.id, version, vEntry)",
    );
    const sigAt = shared.indexOf("await verifyRegistryManifestSignature(");
    const sharedReturnAt = shared.indexOf("return {");
    for (const at of [resolveAt, blockedAt, manifestAt, shaAt, sigAt, sharedReturnAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(blockedAt).toBeGreaterThan(resolveAt);
    expect(manifestAt).toBeGreaterThan(blockedAt);
    expect(shaAt).toBeGreaterThan(manifestAt);
    expect(sigAt).toBeGreaterThan(shaAt);
    expect(sharedReturnAt).toBeGreaterThan(sigAt);
    // The shared chain decides nothing about the key and writes nothing to the Vault or disk.
    expect(shared).not.toMatch(/publisherKeyDecision|extractVerifiedPackage|writeFileSync|vault/);
    // The publisher-key decision (trusted, rotation, Nimbus or owner-accepted; spec R5).
    const vaultAt = fetchBody.indexOf("await publisherKeyDecision(deps, {");
    const writeAt = fetchBody.indexOf("await extractVerifiedPackage(");
    const returnAt = fetchBody.indexOf("return {");
    for (const at of [installedAt, sharedAt, vaultAt, writeAt, returnAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(sharedAt).toBeGreaterThan(installedAt);
    expect(vaultAt).toBeGreaterThan(sharedAt);
    expect(writeAt).toBeGreaterThan(vaultAt);
    expect(returnAt).toBeGreaterThan(writeAt);
    const stage = stripComments(
      await read("packages/gateway/src/extensions/registry/registry-package-stage.ts"),
    );
    expect(bodyOf(stage, "export async function fetchHashedPackage(")).toMatch(
      /if \(!sha256HexEqualConstantTime\(sha256Hex\(packageBytes\), vEntry\.packageSha256\)\) \{\s*throw registryHashMismatch\("package"/,
    );
    const extractBody = bodyOf(stage, "export async function extractVerifiedPackage(");
    const extractWriteAt = extractBody.indexOf("writeFileSync(archivePath, packageBytes)");
    const packagedManifestAt = extractBody.indexOf("vEntry.manifestSha256");
    const stagedEntryAt = extractBody.indexOf("vEntry.entryHash");
    for (const at of [extractWriteAt, packagedManifestAt, stagedEntryAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(stagedEntryAt).toBeGreaterThan(packagedManifestAt);
    // The package carries the INDEX's publisher key, the one the signature and Vault checks used.
    expect(fetchBody).toMatch(/publisherKey: entry\.publisher\.key,/);
    expect(fetchBody).toMatch(
      /publisherKeyDecision\(deps, \{\s*publisherId: entry\.publisher\.id,\s*key: entry\.publisher\.key,/,
    );
    expect(fetchBody).toMatch(/if \(!decision\.ok\) throw publisherKeyConflict\(/);
    // (3) The install half installs ONLY through installExtensionFromLocalDirectory, handed that
    // index key, a registry-scoped dependency resolver and the signed index's entry hash, and is
    // recorded against the SOURCE registry. The entry hash is checked by the plan installer (pinned
    // below) before any edge or audit row, so a mismatch undoes every package of the plan.
    const installBody = bodyOf(src, "export async function installVerifiedRegistryPackage(");
    const resolverAt = installBody.indexOf("createRegistryDependencyResolver(deps, {");
    const localAt = installBody.indexOf("await installExtensionFromLocalDirectory(");
    const sourceAt = installBody.indexOf("setExtensionSource(deps.db, installed.id,");
    for (const at of [resolverAt, localAt, sourceAt]) expect(at).toBeGreaterThan(-1);
    expect(localAt).toBeGreaterThan(resolverAt);
    expect(sourceAt).toBeGreaterThan(localAt);
    expect(installBody).toMatch(/\{ registryPlan: \{ resolver, channel \} \}/);
    // The resolver is skipped ONLY for an installed-only install (the migration, below).
    expect(installBody).toMatch(
      /options\.dependencies === "installed-only"\s*\?\s*undefined\s*:\s*createRegistryDependencyResolver\(deps, \{/,
    );
    expect(installBody).toMatch(/expectedRootEntryHash: pkg\.entryHash,/);
    expect(installBody).toMatch(/publisherKey: decodeBase64\(pkg\.publisherKey\),/);
    expect(installBody).toMatch(/sourceRegistry: reg\.name,/);
    // ...and inside it the I16 signature of the COPIED manifest is re-verified against that key
    // before the extension row is written: the install lands only after verification.
    const copySrc = await readExt("install-from-local/copy-and-verify.ts");
    const [, afterCopy = ""] = copySrc.split("async function completeExtensionInstallAfterCopy(");
    const reverifyAt = afterCopy.indexOf("await verifyAndRecordSignature(options, destManifest");
    const rowAt = afterCopy.indexOf("insertExtensionRow(options.db,");
    expect(reverifyAt).toBeGreaterThan(-1);
    expect(rowAt).toBeGreaterThan(reverifyAt);
    const local = await readExt("install-from-local/plan-install.ts");
    // The plan installer: every installed registry package's entry hash (each dependency against
    // its index entry, the root against expectedRootEntryHash) is checked before the edges and the
    // audit row are recorded, and any failure rolls back every package the plan created.
    const planBody = local.slice(local.indexOf("async function installApprovedPlan("));
    const rootCheckAt = planBody.indexOf(
      "assertInstalledEntryHash(root, options.expectedRootEntryHash)",
    );
    const depInstallAt = planBody.indexOf("await installStagedDependency(");
    const recordAt = planBody.indexOf("recordPlanInstallAndAudit(");
    const rollbackAt = planBody.indexOf("rollbackCreatedPackages(options.db, created)");
    for (const at of [rootCheckAt, depInstallAt, recordAt, rollbackAt]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(recordAt).toBeGreaterThan(Math.max(rootCheckAt, depInstallAt));
    expect(rollbackAt).toBeGreaterThan(recordAt);
    const depFn = local.slice(local.indexOf("async function installStagedDependency("));
    expect(depFn.slice(0, depFn.indexOf("\n}\n"))).toMatch(
      /assertInstalledEntryHash\(installed, dep\.vEntry\.entryHash\);[\s\S]*setExtensionSource\(/,
    );
    // (4) Only two production files may name the install half (a call, an import or an alias): the
    // composition above, and the migration engine, which rebuilds the package from a stage whose
    // tree digest equals the one fetchVerifiedRegistryPackage verified, and requires the installed
    // digest to equal it too.
    const callers = (await readDirFiles("packages/gateway/src"))
      .filter((f) => /\binstallVerifiedRegistryPackage\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual([
      "extensions/migration/migration-engine.ts",
      "extensions/registry/install-from-registry.ts",
    ]);
    // A migration installs exactly ONE package (spec § 8.1): its `extension.migrate` consent names
    // only the root, so its install builds no dependency resolver and fetches no dependency — every
    // call of the install half in the engine passes the installed-only option.
    const migrationSrc = stripComments(
      await read("packages/gateway/src/extensions/migration/migration-engine.ts"),
    );
    const migrationCalls = [
      ...migrationSrc.matchAll(
        /await install\(installDeps\([^)]*\), pkg, "stable"(, \{[^}]*\})?\)/g,
      ),
    ];
    expect(migrationCalls).toHaveLength(1);
    expect(migrationCalls[0]?.[1]).toMatch(/dependencies: "installed-only"/);
    expect(migrationSrc).toMatch(
      /const install = deps\.installVerified \?\? installVerifiedRegistryPackage;/,
    );
    expect(migrationSrc.match(/\bawait install\(/g)).toHaveLength(1);
    // Resolution reads only freshly VERIFIED indexes, and refuses ambiguity.
    const resolver = stripComments(
      await read("packages/gateway/src/extensions/registry/registry-resolve.ts"),
    );
    expect(resolver).toMatch(/targets\.map\(\(reg\) => fetchVerifiedIndex\(deps, reg\)\)/);
    expect(resolver).toMatch(
      /if \(carrying\.length > 1\) \{\s*throw new RegistryError\(\s*"ERR_REGISTRY_AMBIGUOUS"/,
    );
    // …and refuses a bare id while any configured registry failed this call (no reachability priority).
    expect(resolver).toMatch(
      /if \(registryName === undefined\) \{\s*throw new RegistryError\(\s*"ERR_REGISTRY_AMBIGUOUS"/,
    );
    expect(resolver.indexOf("if (read.failures.length > 0) {")).toBeGreaterThan(-1);
    expect(resolver.indexOf("if (read.failures.length > 0) {")).toBeLessThan(
      resolver.indexOf("const found = carrying[0];"),
    );
    // Verified = the pinned root key, then the non-decreasing sequence.
    const fetchSrc = stripComments(
      await read("packages/gateway/src/extensions/registry/registry-fetch.ts"),
    );
    const verifiedAt = fetchSrc.indexOf("export async function fetchVerifiedIndex(");
    expect(verifiedAt).toBeGreaterThan(-1);
    const verified = fetchSrc.slice(
      verifiedAt,
      fetchSrc.indexOf("export async function", verifiedAt + 1),
    );
    const pinnedAt = verified.indexOf("await verifyRegistryIndexPinned(index, reg.rootKey);");
    const seqAt = verified.indexOf("if (index.sequence < reg.lastSequence)");
    expect(pinnedAt).toBeGreaterThan(-1);
    expect(seqAt).toBeGreaterThan(pinnedAt);
    // The source columns are written by ONE production function, called from the registry installer
    // (the root) and from the plan installer for a dependency it staged from a verified registry
    // resolution (a `StagedDependency`, which only `RegistryDependencyResolver.stage` produces).
    const files = await readDirFiles("packages/gateway/src");
    const sourceWriters = files
      .filter((f) => /UPDATE\s+extension\s+SET[^;]*\bsource_/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(sourceWriters).toEqual(["extensions/registry/registry-store.ts"]);
    const setSourceCallers = files
      .filter((f) => f.rel !== "extensions/registry/registry-store.ts")
      .filter((f) => /\bsetExtensionSource\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(setSourceCallers).toEqual([
      "extensions/install-from-local/plan-install.ts",
      "extensions/registry/install-from-registry.ts",
    ]);
    const localSrc = await readExt("install-from-local/plan-install.ts");
    expect(localSrc.match(/\bsetExtensionSource\(/g)).toHaveLength(1);
    const stagedDepFn = localSrc.slice(localSrc.indexOf("async function installStagedDependency("));
    expect(stagedDepFn.slice(0, stagedDepFn.indexOf("\n}\n"))).toMatch(
      /dep: StagedDependency,[\s\S]*setExtensionSource\(options\.db, dep\.id, \{\s*registry: dep\.reg\.name,/,
    );
    // `StagedDependency` is a structural type and `registryPlan` an option, so what makes the
    // dependency source write above verified-chain-only is WHO can hand the plan installer a
    // resolver: only the registry installer names `registryPlan` (besides the install-from-local
    // modules below, which declare and read it) or the resolver factory (besides its defining module).
    const production = files.filter((f) => !f.rel.endsWith(".test.ts"));
    const localModules =
      /^extensions\/install-from-local(\/(approval-request|plan-install|promotion|solver-inputs|types))?\.ts$/;
    const namingPlan = production
      .filter((f) => !localModules.test(f.rel))
      .filter((f) => /\bregistryPlan\b/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(namingPlan).toEqual(["extensions/registry/install-from-registry.ts"]);
    const namingFactory = production
      .filter((f) => f.rel !== "extensions/registry/registry-dependency-fetcher.ts")
      .filter((f) => /\bcreateRegistryDependencyResolver\b/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(namingFactory).toEqual(["extensions/registry/install-from-registry.ts"]);
  });

  // ---- an author's clone (`registry.cloneSource`) --------------------------------------------

  test("behavioural: a clone of an unknown-key package writes no extension row", async () => {
    const { cloneRegistrySource } = await import("../extensions/registry/clone-source.ts");
    const s = await setup({ main: ["1.0.0"] });
    const out = await cloneRegistrySource(
      { db: s.db, fetch: NO_NETWORK },
      { id: ID },
      join(s.root, "data", "registry-clone-staging"),
    );
    expect(out.version).toBe("1.0.0");
    expect(readFileSync(out.archivePath).byteLength).toBeGreaterThan(0);
    expect(installedIds(s.db)).toEqual([]);
    // No Vault write is structural, not observed: `CloneSourceDeps` carries no Vault at all, and the
    // source pin below forbids `vault` and `publisherKeyDecision` in the clone path.
  });

  test("behavioural: a clone of a blocked version is refused, and nothing is staged", async () => {
    const { cloneRegistrySource } = await import("../extensions/registry/clone-source.ts");
    const { signTrustStatement } = await import("@nimbus-dev/registry-format");
    const { recordTrustStatements } = await import("../extensions/trust/trust-store.ts");
    const { TrustBlockError } = await import("../extensions/trust/trust-blocks.ts");
    const { encodeBase64 } = await import("../util/base64.ts");
    const nacl = (await import("tweetnacl")).default;
    const s = await setup({ main: ["1.0.0"] });
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const statement = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: ID,
        publisherId: "acme",
        versions: "*",
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(s.db, [statement], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    const staging = join(s.root, "data", "registry-clone-staging");
    const settled = await cloneRegistrySource({ db: s.db, fetch: NO_NETWORK }, { id: ID }, staging)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(TrustBlockError);
    expect(readdirSync(staging)).toEqual([]);
  });

  test("source pin: a clone goes through install's shared verified chain and makes no key decision", async () => {
    const forbidden =
      /publisherKeyDecision|extractVerifiedPackage|installExtensionFromLocalDirectory|writePublisherKey|fetchRegistryBytes|fetchHashedPackage|resolveRegistryEntry|vault/i;
    const file = stripComments(
      await read("packages/gateway/src/extensions/registry/clone-source.ts"),
    );
    // The clone function's own body, bounded at the next top-level declaration.
    const fnAt = file.indexOf("export async function cloneRegistrySource(");
    expect(fnAt).toBeGreaterThan(-1);
    const fnEnd = file.indexOf("\n}\n", fnAt);
    const fn = file.slice(fnAt, fnEnd === -1 ? undefined : fnEnd);
    expect(fn).toMatch(/await fetchVerifiedPackageBytes\(fetchDeps, deps\.db, \{/);
    // The archive is written only after the chain returned.
    expect(fn.indexOf("writeFileSync(")).toBeGreaterThan(
      fn.indexOf("await fetchVerifiedPackageBytes("),
    );
    // Nothing installed, extracted, approved or trusted, and no second way to the registry bytes —
    // in the function, and anywhere in its module (so its deps type carries no Vault either).
    expect(fn).not.toMatch(forbidden);
    expect(file).not.toMatch(forbidden);
    // The RPC door refreshes the trust feed (I48) BEFORE the clone, and hands it no Vault or gate.
    const rpc = stripComments(await read("packages/gateway/src/ipc/registry-rpc.ts"));
    const doorAt = rpc.indexOf("async function handleCloneSource(");
    expect(doorAt).toBeGreaterThan(-1);
    const door = rpc.slice(doorAt, rpc.indexOf("\n}\n", doorAt));
    const freshAt = door.indexOf("await freshenTrustFeed(o.trustFeed, o.db, Date.now());");
    const cloneAt = door.indexOf("await cloneRegistrySource(");
    expect(freshAt).toBeGreaterThan(-1);
    expect(cloneAt).toBeGreaterThan(freshAt);
    expect(door).not.toMatch(/vault|ownerGate|publisherKeyDecision/i);
  });

  // ---- dependencies (extension dependencies, PR 2) -------------------------------------------

  const DEP = "com.example.i44.dep";
  const DEP2 = "com.example.i44.dep2";

  /** Remote registries (`https://<name>.test/`) served from folders; every requested URL is logged. */
  async function remoteSetup(
    registries: Record<
      string,
      Record<string, Array<{ version: string; dependsOn?: Record<string, unknown> }>>
    >,
  ) {
    const { buildMultiExtensionRegistry } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const { insertRegistry } = await import("../extensions/registry/registry-store.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = mkdtempSync(join(tmpdir(), "nimbus-i44-deps-"));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    const dirs = new Map<string, string>();
    for (const [name, exts] of Object.entries(registries)) {
      const dir = join(root, `registry-${name}`);
      const keys = await buildMultiExtensionRegistry(dir, exts as never);
      insertRegistry(db, {
        name,
        url: `https://${name}.test/`,
        rootKey: keys.rootKey,
        rootFingerprint: publisherKeyFingerprint(keys.rootKey),
        lastSequence: 0,
        lastGeneratedAt: "2026-10-01T00:00:00Z",
        addedAt: 1,
        lastIndexSha256: null,
      });
      dirs.set(name, dir);
    }
    const urls: string[] = [];
    const fetchBag = {
      ...NO_NETWORK,
      fetchFn: (url: string) => {
        urls.push(url);
        const u = new URL(url);
        const dir = dirs.get(u.hostname.replace(/\.test$/, ""));
        if (dir === undefined) return Promise.resolve(new Response("down", { status: 503 }));
        try {
          return Promise.resolve(
            new Response(readFileSync(join(dir, ...u.pathname.split("/").filter(Boolean)))),
          );
        } catch {
          return Promise.resolve(new Response("missing", { status: 404 }));
        }
      },
    };
    return { db, urls, fetchBag, vault: new MockVault(), extensionsDir: join(root, "extensions") };
  }

  type RemoteSetup = Awaited<ReturnType<typeof remoteSetup>>;

  /** `registry.install` exactly as the CLI reaches it, recording every type the owner gate is asked. */
  async function installViaRpc(s: RemoteSetup, id: string, registry: string) {
    const { dispatchRegistryRpc } = await import("../ipc/registry-rpc.ts");
    const asked: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const run = dispatchRegistryRpc({
      method: "registry.install",
      params: { id, registry },
      db: s.db,
      fetch: s.fetchBag,
      extensionsDir: s.extensionsDir,
      vault: s.vault,
      ownerGate: async (a) => {
        asked.push(a);
        return true;
      },
    });
    return { run, asked };
  }

  test("behavioural: a string dependency is never fetched from another registry", async () => {
    // Both registries carry the dependency; the root lives in `main` and names it by bare range.
    const s = await remoteSetup({
      main: {
        [ID]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } }],
        [DEP]: [{ version: "1.0.0" }],
      },
      other: { [DEP]: [{ version: "1.0.0" }] },
    });
    const { run } = await installViaRpc(s, ID, "main");
    await run;
    expect(installedIds(s.db).sort()).toEqual([DEP, ID].sort());
    // The callee: the dependency's manifest and package were requested from `main` and from no other
    // registry (a positive control: the same URLs under `other` are what a wrong source would hit).
    const forDep = s.urls.filter((u) => u.includes(`/extensions/${DEP}/`));
    expect(forDep).toEqual([
      `https://main.test/extensions/${DEP}/1.0.0/manifest.json`,
      `https://main.test/extensions/${DEP}/1.0.0/package.tgz`,
    ]);
    expect(
      s.urls.filter((u) => u.includes("/extensions/") && u.startsWith("https://other.test/")),
    ).toEqual([]);
    // Ledger rows by registry: the dependency's one `registry.manifest` row names the root's registry.
    const rows = s.db
      .query(
        "SELECT payload_summary AS p FROM egress_ledger WHERE method = 'registry.manifest' AND payload_summary LIKE ?",
      )
      .all(`%${DEP}%`) as Array<{ p: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.p).toContain("main.test");
    expect(rows[0]?.p).not.toContain("other.test");

    // An installed copy satisfies the dependency only when it came from that registry: a copy the
    // owner installed from `other` is refused for a root that resolves its dependency to `main`,
    // before any prompt, and its recorded source is untouched.
    const t = await remoteSetup({
      main: {
        [ID]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } }],
        [DEP]: [{ version: "1.0.0" }],
      },
      other: { [DEP]: [{ version: "1.0.0" }] },
    });
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const { getExtensionSource } = await import("../extensions/registry/registry-store.ts");
    let asked = 0;
    const deps = {
      db: t.db,
      extensionsDir: t.extensionsDir,
      vault: t.vault,
      fetch: t.fetchBag,
      approve: async () => {
        asked++;
        return true;
      },
    };
    await installFromRegistry(deps, { id: DEP, registry: "other" });
    const askedBefore = asked;
    expect(await refusalOf(installFromRegistry(deps, { id: ID, registry: "main" }))).toMatch(
      /^ERR_DEPENDENCY_SOURCE_MISMATCH /,
    );
    expect(asked).toBe(askedBefore);
    expect(installedIds(t.db)).toEqual([DEP]);
    expect(getExtensionSource(t.db, DEP)?.registry).toBe("other");
  });

  test("behavioural: a dependency's registry must already be added", async () => {
    const s = await remoteSetup({
      main: {
        [ID]: [
          {
            version: "1.0.0",
            dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://nowhere.test/" } },
          },
        ],
      },
    });
    const { run, asked } = await installViaRpc(s, ID, "main");
    await expect(run).rejects.toThrow(/not one of your registries/);
    // No `registry.add` (nor any prompt at all) was raised: a manifest cannot add a trust root.
    expect(asked.map((a) => a.type)).not.toContain("registry.add");
    expect(asked).toEqual([]);
    const { listRegistries } = await import("../extensions/registry/registry-store.ts");
    expect(listRegistries(s.db).map((r) => r.name)).toEqual(["main"]);
    expect(installedIds(s.db)).toEqual([]);
    expect(s.urls.filter((u) => u.includes("nowhere.test"))).toEqual([]);
    // The refusal code, through the installer itself.
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const direct = installFromRegistry(
      {
        db: s.db,
        extensionsDir: s.extensionsDir,
        vault: s.vault,
        fetch: s.fetchBag,
        approve: async () => true,
      },
      { id: ID, registry: "main" },
    );
    expect(await refusalOf(direct)).toMatch(/^ERR_DEPENDENCY_REGISTRY_NOT_ADDED /);
  });

  test("behavioural: every package installed by a plan is in the approval", async () => {
    // Root -> DEP -> DEP2: two packages the owner never named. The approval request is the only
    // thing the owner answers, so each installed id must appear in its `plan`.
    const s = await remoteSetup({
      main: {
        [ID]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } }],
        [DEP]: [{ version: "1.0.0", dependsOn: { [DEP2]: "^1.0.0" } }],
        [DEP2]: [{ version: "1.0.0" }],
      },
    });
    const asked: Array<{ plan?: ReadonlyArray<{ id: string }> }> = [];
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    await installFromRegistry(
      {
        db: s.db,
        extensionsDir: s.extensionsDir,
        vault: s.vault,
        fetch: s.fetchBag,
        approve: async (request) => {
          asked.push(request as never);
          return true;
        },
      },
      { id: ID, registry: "main" },
    );
    expect(asked).toHaveLength(1);
    const approved = new Set((asked[0]?.plan ?? []).map((p) => p.id));
    const installed = installedIds(s.db);
    expect(installed).toHaveLength(3);
    for (const id of installed) expect(approved.has(id), id).toBe(true);
  });

  test("behavioural: an update's new dependency comes only from the registry its declaration resolves to, verified", async () => {
    // 1.2.0 adds DEP by bare range, so it resolves to the root's own registry. `other` carries the
    // same DEP under the same root key: a resolver pointed anywhere else would fetch it from there.
    const versions = {
      [ID]: [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    };
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const { getExtensionSource } = await import("../extensions/registry/registry-store.ts");
    const { createAutoUpdateRuntime } = await import("../extensions/auto-update-init.ts");
    const { dispatchAutoUpdateRpc, _resetAutoUpdateMutexForTests } = await import(
      "../extensions/auto-update-rpc.ts"
    );
    async function updateWith(s: RemoteSetup, atGate: () => void) {
      await installFromRegistry(
        {
          db: s.db,
          extensionsDir: s.extensionsDir,
          vault: s.vault,
          fetch: s.fetchBag,
          approve: async () => true,
        },
        { id: ID, registry: "main", version: "1.0.0" },
      );
      const runtime = createAutoUpdateRuntime({
        db: s.db,
        vault: s.vault,
        extensionsDir: s.extensionsDir,
        dataDir: join(s.extensionsDir, "..", "data"),
        fetch: s.fetchBag,
        intervalHours: 24,
      });
      await runtime.deps.forcePoll();
      _resetAutoUpdateMutexForTests();
      return (await dispatchAutoUpdateRpc(
        "extension.update",
        { id: ID, toVersion: "1.2.0" },
        {
          ...runtime.deps,
          gate: async () => {
            atGate();
            return "proceed" as const;
          },
        },
      )) as { applied: boolean; reason?: string };
    }

    const s = await remoteSetup({ main: versions, other: { [DEP]: [{ version: "1.0.0" }] } });
    expect(await updateWith(s, () => {})).toMatchObject({ applied: true });
    expect(installedIds(s.db).sort()).toEqual([DEP, ID].sort());
    expect(getExtensionSource(s.db, DEP)?.registry).toBe("main");
    const forDep = s.urls.filter((u) => u.includes(`/extensions/${DEP}/`));
    expect(forDep.filter((u) => u.endsWith("/package.tgz"))).toEqual([
      `https://main.test/extensions/${DEP}/1.0.0/package.tgz`,
    ]);
    expect(forDep.length).toBeGreaterThan(1);
    for (const u of forDep) expect(u.startsWith("https://main.test/")).toBe(true);
    expect(s.urls.some((u) => u.startsWith("https://other.test/"))).toBe(false);

    // Verified: package bytes the signed index does not cover are refused at apply, and the update
    // installs nothing (the root stays at 1.0.0).
    const t = await remoteSetup({ main: versions });
    const tampered = await updateWith(t, () => {
      const pkg = join(t.extensionsDir, "..", "registry-main", "extensions", DEP, "1.0.0");
      writeFileSync(join(pkg, "package.tgz"), "tampered");
    });
    // Refused as a verification failure, after exactly one (ledgered) download of DEP's package:
    // the bytes were fetched, hash-checked and never installed.
    expect(tampered).toEqual({ applied: false, reason: "signature_failed" });
    const depPackageRows = t.db
      .query(
        "SELECT COUNT(*) AS n FROM egress_ledger WHERE method = 'registry.package' AND payload_summary LIKE ?",
      )
      .get(`%${DEP}%`) as { n: number };
    expect(depPackageRows.n).toBe(1);
    expect(installedIds(t.db)).toEqual([ID]);
    expect(existsSync(join(t.extensionsDir, DEP))).toBe(false);
    expect(
      (t.db.query("SELECT version FROM extension WHERE id = ?").get(ID) as { version: string })
        .version,
    ).toBe("1.0.0");
  });

  test("source pin: installExtensionFromLocalDirectory asks the owner before anything is staged", async () => {
    const doorSrc = await readExt("install-from-local.ts");
    const [, door = ""] = doorSrc.split(
      "export async function installExtensionFromLocalDirectory(",
    );
    expect(door).not.toBe("");
    const local = await readExt("install-from-local/plan-install.ts");
    const askAt = door.indexOf("await requireInstallApproval(");
    const installAt = door.indexOf("await installApprovedPlan(");
    expect(askAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(askAt);
    // `stage(` (a dependency's fetch-and-extract) exists once, inside the helper only the plan
    // installer calls — so it cannot run before the approval above.
    expect(local.match(/\.stage\(/g)).toHaveLength(1);
    const helperAt = local.indexOf("async function stageNewDependencies(");
    const helper = local.slice(helperAt, local.indexOf("\nasync function", helperAt + 1));
    expect(helper).toMatch(/\.stage\(/);
    // Its definition and two callers: the plan installer below, and the dependency half of an
    // update's already-approved plan (`installPlanDependencies`), whose approval is the update's
    // own `extension.autoUpdate` prompt (pinned after this list).
    expect(local.match(/\bstageNewDependencies\(/g)).toHaveLength(3);
    const planAt = local.indexOf("async function installApprovedPlan(");
    const planEnd = local.indexOf("\nexport ", planAt + 1);
    const plan = local.slice(planAt, planEnd);
    expect(plan.match(/await stageNewDependencies\(/g)).toHaveLength(1);
    expect(plan).not.toMatch(/requireInstallApproval/);
    const depsAt = local.indexOf("export async function installPlanDependencies(");
    expect(depsAt).toBeGreaterThan(planEnd - 1);
    const depsHalf = local.slice(depsAt, local.indexOf("\nexport ", depsAt + 1));
    expect(depsHalf.match(/await stageNewDependencies\(/g)).toHaveLength(1);
    expect(depsHalf).not.toMatch(/requireInstallApproval|installVerifiedRegistryPackage/);
    // The dependency half is reached only through the registry installer's update step, and that
    // step only from the update runtime's apply (after its re-verification, pinned below).
    const prod = (await readDirFiles("packages/gateway/src")).filter(
      (f) => !f.rel.endsWith(".test.ts"),
    );
    const namingHalf = prod
      .filter((f) => /\binstallPlanDependencies\b/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .sort();
    expect(namingHalf).toEqual([
      "extensions/install-from-local.ts",
      "extensions/install-from-local/plan-install.ts",
      "extensions/registry/install-from-registry.ts",
    ]);
    const registrySrc = stripComments(
      await read("packages/gateway/src/extensions/registry/install-from-registry.ts"),
    );
    expect(registrySrc.match(/\binstallPlanDependencies\(/g)).toHaveLength(1);
    // Exactly one definition and no in-module caller of the dependency half in install-from-local.ts,
    // and exactly one definition plus one call of the update step: a second caller fails the count.
    expect(local.match(/\binstallPlanDependencies\(/g)).toHaveLength(1);
    expect(local.match(/\bfunction installPlanDependencies\(/g)).toHaveLength(1);
    expect(registrySrc.match(/\binstallUpdateDependencies\(/g)).toHaveLength(1);
    expect(registrySrc.match(/\bfunction installUpdateDependencies\(/g)).toHaveLength(1);
    const stepAt = registrySrc.indexOf("export async function installUpdateDependencies(");
    expect(stepAt).toBeGreaterThan(-1);
    expect(registrySrc.indexOf("await installPlanDependencies(")).toBeGreaterThan(stepAt);
    const namingStep = prod
      .filter((f) => f.rel !== "extensions/registry/install-from-registry.ts")
      .filter((f) => /\binstallUpdateDependencies\b/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(namingStep).toEqual(["extensions/auto-update-init.ts"]);
    const initSrc = stripComments(
      await read("packages/gateway/src/extensions/auto-update-init.ts"),
    );
    expect(initSrc.match(/\binstallUpdateDependencies\(/g)).toHaveLength(1);
    expect(initSrc.match(/\binstallUpdateDependencies\b/g)).toHaveLength(2);
  });

  test("source pin: the migration engine's accept re-digests the stage, installs with the BUILTIN registry row, then checks the installed digest", async () => {
    // The engine is the second production caller of `installVerifiedRegistryPackage` (above). It
    // rebuilds the package from its stage rather than refetching, so what makes that install a
    // verified-chain install is this exact order, AFTER the owner's one `extension.migrate` answer.
    const src = stripComments(
      await read("packages/gateway/src/extensions/migration/migration-engine.ts"),
    );
    const stagedAt = src.indexOf("const installStaged = async (");
    const startAt = src.indexOf("const acceptLocked = async (");
    expect(stagedAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(stagedAt);
    // `installStaged` is the install half; `acceptLocked` is the order around it.
    const installHalf = src.slice(stagedAt, startAt);
    const accept = src.slice(startAt, src.indexOf("\n  return {", startAt));
    const consentAt = accept.indexOf("const approved = await consent(");
    const notApprovedAt = accept.indexOf('"ERR_EXTENSION_MIGRATION_NOT_APPROVED"');
    // (1) The stage is re-digested against the row's tree_digest after the prompt, and only then
    // is the install half called…
    const reDigestAt = accept.indexOf("\n    requireIntactStage(row);", notApprovedAt);
    const callAt = accept.indexOf("await installStaged(row, entry, builtinReg,");
    // (2) …the package carries the BUILT-IN registry row (never an owner registry) and is installed
    // through the verified install half, with the approver that exists only past the answer…
    const regAt = installHalf.indexOf("reg: builtinRegistryRow(db, reg),");
    const approverAt = installHalf.indexOf(
      "const approvedByMigrationConsent: ExtensionInstallApprover = () => Promise.resolve(true);",
    );
    const installAt = installHalf.indexOf(
      'await install(installDeps(reg, approvedByMigrationConsent), pkg, "stable", {',
    );
    // (3) …and the INSTALLED tree must carry the staged digest, in the row and in the result,
    // before the run grant is written.
    const installedAt = installHalf.indexOf(
      "installedRow?.tree_digest !== row.treeDigest || installed.treeDigest !== row.treeDigest",
    );
    const grantAt = accept.indexOf("await approveMigratedExtensionRun(");
    for (const at of [
      consentAt,
      notApprovedAt,
      reDigestAt,
      callAt,
      regAt,
      approverAt,
      installAt,
      installedAt,
      grantAt,
    ]) {
      expect(at).toBeGreaterThan(-1);
    }
    expect(notApprovedAt).toBeGreaterThan(consentAt);
    expect(reDigestAt).toBeGreaterThan(notApprovedAt);
    expect(callAt).toBeGreaterThan(reDigestAt);
    expect(approverAt).toBeGreaterThan(regAt);
    expect(installAt).toBeGreaterThan(Math.max(regAt, approverAt));
    expect(installedAt).toBeGreaterThan(installAt);
    expect(grantAt).toBeGreaterThan(callAt);
    // The registry handed to the install half IS the built-in config: `requireAcceptable` returns
    // `builtin` itself, `acceptLocked` destructures it, and nothing in `acceptLocked` installs
    // directly (a direct `install(` there would bypass the pinned order above).
    const acceptable = src.slice(src.indexOf("const requireAcceptable = ("), stagedAt);
    expect(acceptable).toContain("return { entry, reg: builtin };");
    expect(accept).toContain("const { entry, reg: builtinReg } = requireAcceptable(row);");
    expect(accept).not.toContain("await install(");
    // The re-digest is a real digest comparison against the row, through the extension store's own
    // digest function — not an existence check.
    const checkAt = src.indexOf("const checkStage = (row: MigrationRow): StageCheck => {");
    expect(checkAt).toBeGreaterThan(-1);
    const check = src.slice(checkAt, src.indexOf("\n  };", checkAt));
    expect(check).toContain("const live = digestOrNull(stagePath);");
    expect(check).toContain("live !== null && live === row.treeDigest");
    expect(src).toMatch(/return computeExtensionTreeDigest\(root\);/);
    expect(src).toContain(
      "const install = deps.installVerified ?? installVerifiedRegistryPackage;",
    );
  });

  test("M3: the migration engine's test seams are never named by production code outside the engine", async () => {
    // `installVerified` and `removeInstallTree` replace the verified install and the undo's removal.
    // The production constructor (`platform/migration-boot.ts`) builds the deps field by field, and
    // no other non-test gateway file may name either seam.
    const offenders = (await readDirFiles("packages/gateway/src"))
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => f.rel !== "extensions/migration/migration-engine.ts")
      .filter((f) => /\b(?:installVerified|removeInstallTree)\b/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
    const boot = stripComments(await read("packages/gateway/src/platform/migration-boot.ts"));
    expect(boot).toMatch(/return createMigrationEngine\(\{/);
    expect(boot).not.toMatch(/\.\.\.\s*d\b/);
  });

  test("source pin: an update is detected from the source registry only, and apply re-verifies before the swap", async () => {
    const detect = stripComments(
      await read("packages/gateway/src/extensions/registry/registry-update-source.ts"),
    );
    expect(detect).toContain(
      "const reg = resolveRegistry(deps.db, name, builtinRegistryOf(deps.fetch));",
    );
    expect(detect).toContain("r.source.rootFingerprint === reg.rootFingerprint");
    const orch = stripComments(
      await read("packages/gateway/src/extensions/auto-update-orchestrate.ts"),
    );
    const upAt = orch.indexOf("export function createPerformUpgrade(");
    expect(upAt).toBeGreaterThan(-1);
    const up = orch.slice(upAt, orch.indexOf("export interface PerformDowngradeDeps"));
    const reverifyAt = up.indexOf("await deps.reverifyManifest(update, deps.signal);");
    const fetchAt = up.indexOf("await deps.fetchPackage(update, deps.signal);");
    const shaAt = up.indexOf('throw new Error("sha256_mismatch");');
    const swapAt = up.indexOf("await applyUpgradeSwap(");
    for (const at of [reverifyAt, fetchAt, shaAt, swapAt]) expect(at).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(reverifyAt);
    expect(swapAt).toBeGreaterThan(Math.max(reverifyAt, shaAt));
    // The production runtime wires the REAL re-verification and fetches from the source only.
    const init = stripComments(await read("packages/gateway/src/extensions/auto-update-init.ts"));
    expect(init).toMatch(
      /reverifyManifest: async \(update, signal\) => \{\s*await opts\.freshenTrust\?\.\(\);\s*verifiedKeys\.set\(\s*updateKey\(update\),\s*await reverifyUpdateManifest\(fetchDeps, opts\.vault, update, signal\),\s*\);\s*\},/,
    );
    expect(init).toMatch(
      /fetchRegistryBytes\(\s*fetchDeps,\s*sourceRegistryOf\(fetchDeps, update\),/,
    );
    const rvAt = init.indexOf("async function reverifyUpdateManifest(");
    expect(rvAt).toBeGreaterThan(-1);
    const rv = init.slice(rvAt, init.indexOf("export function createAutoUpdateRuntime("));
    const order = [
      "const reg = sourceRegistryOf(fetchDeps, update);",
      "await fetchVerifiedIndex(fetchDeps, reg, signal);",
      "await fetchRegistryManifest(",
      "await publisherKeyDecision(",
      "await verifyRegistryManifestSignature(",
    ].map((needle) => rv.indexOf(needle));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The upgrade is built in exactly one production place: that runtime.
    const callers = (await readDirFiles("packages/gateway/src"))
      .filter((f) => /(?<!function )\bcreatePerformUpgrade\(/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(callers).toEqual(["extensions/auto-update-init.ts"]);
  });
});

describe("I44/I48 — publisher key rotation (trust layer PR 3a)", () => {
  // Real stored statements, a real local-folder registry and the real installer; nothing spawns.
  const roots: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  async function registryWithTrustedOldKey() {
    const nacl = (await import("tweetnacl")).default;
    const { PUBLISHER_SEED } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    const { insertRegistry } = await import("../extensions/registry/registry-store.ts");
    const { writePublisherKey } = await import("../extensions/publisher-keys.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = mkdtempSync(join(tmpdir(), "nimbus-rot-"));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    const dir = join(root, "registry");
    const built = await buildTestRegistry(dir, {
      id: "com.example.rot",
      versions: [{ version: "1.0.0" }],
    });
    insertRegistry(db, {
      name: "main",
      url: dir,
      rootKey: built.rootKey,
      rootFingerprint: publisherKeyFingerprint(built.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const oldSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 160);
    const oldKey = encodeBase64(nacl.sign.keyPair.fromSeed(oldSeed).publicKey);
    const newKey = encodeBase64(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey);
    const vault = new MockVault();
    await writePublisherKey(vault, "acme", Buffer.from(oldKey, "base64"));
    let asked = 0;
    const deps = {
      db,
      extensionsDir: join(root, "extensions"),
      vault,
      fetch: {
        fetchFn: () => Promise.reject(new Error("no network")),
        enforceAirGap: () => false,
        now: () => Date.now(),
        production: false,
        builtin: null,
      },
      approve: async () => {
        asked++;
        return true;
      },
    };
    return { db, deps, oldSeed, oldKey, newKey, asked: () => asked };
  }

  async function store(
    db: Database,
    s: Parameters<typeof signTrustStatementDyn>[0],
    seed: Uint8Array,
  ) {
    const { recordTrustStatements } = await import("../extensions/trust/trust-store.ts");
    const signed = await signTrustStatementDyn(s, seed);
    const feedRoot = encodeBase64(new Uint8Array(32).fill(4));
    recordTrustStatements(db, [signed], { kind: "feed", nimbusRootKey: feedRoot }, 1);
  }

  test("an unvouched key change refuses install before the owner is asked; a mismatched acceptance too", async () => {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const x = await registryWithTrustedOldKey();
    await expect(installFromRegistry(x.deps, { id: "com.example.rot" })).rejects.toThrow(
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
    );
    await expect(
      installFromRegistry(x.deps, { id: "com.example.rot", acceptPublisherKey: "0".repeat(32) }),
    ).rejects.toThrow("ERR_REGISTRY_PUBLISHER_KEY_CONFLICT");
    expect(x.asked()).toBe(0);
  });

  test("a rotation from the trusted key installs; once the old key is revoked the new one is blocked (R4)", async () => {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const { blocksFor } = await import("../extensions/trust/trust-blocks.ts");
    const x = await registryWithTrustedOldKey();
    await store(
      x.db,
      {
        kind: "key.rotate",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: x.oldKey,
        publisherId: "acme",
        fromKey: x.oldKey,
        toKey: x.newKey,
      },
      x.oldSeed,
    );
    expect((await installFromRegistry(x.deps, { id: "com.example.rot" })).version).toBe("1.0.0");
    // The leaked old key revokes itself later: the key it rotated to is now blocked as well.
    await store(
      x.db,
      {
        kind: "key.revoke",
        issuedAt: "2026-10-27T12:00:00Z",
        signerKey: x.oldKey,
        publisherId: "acme",
        keyFingerprint: publisherKeyFingerprint(x.oldKey),
        reason: "leaked",
      },
      x.oldSeed,
    );
    const blocks = blocksFor(x.db, {
      extensionId: "com.example.rot",
      version: "1.0.0",
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(x.newKey),
      source: null,
    });
    expect(blocks.map((b) => b.kind)).toEqual(["key.revoke"]);
    expect(blocks[0]?.reason).toContain("was rotated from revoked key");
  });

  test("the owner's exact-fingerprint acceptance installs, and the prompt discloses the unvouched change", async () => {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const x = await registryWithTrustedOldKey();
    const asked: Array<Record<string, unknown>> = [];
    const out = await installFromRegistry(
      {
        ...x.deps,
        approve: async (r: Record<string, unknown>) => {
          asked.push(r);
          return true;
        },
      },
      { id: "com.example.rot", acceptPublisherKey: publisherKeyFingerprint(x.newKey) },
    );
    expect(out.version).toBe("1.0.0");
    expect(asked[0]?.["publisherChange"]).toEqual({
      from: [publisherKeyFingerprint(x.oldKey)],
      to: publisherKeyFingerprint(x.newKey),
      via: "owner",
    });
    expect(asked[0]?.["publisherChangeNote"]).toBe(
      `publisher key CHANGED from ${publisherKeyFingerprint(x.oldKey)} to ${publisherKeyFingerprint(x.newKey)}, not vouched for by any rotation or by Nimbus`,
    );
  });

  test("a revoked key is refused even with the owner's matching acceptance, before the owner is asked", async () => {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const x = await registryWithTrustedOldKey();
    const nacl = (await import("tweetnacl")).default;
    const { PUBLISHER_SEED } = await import(
      "../extensions/registry/__fixtures__/build-test-registry.ts"
    );
    await store(
      x.db,
      {
        kind: "key.revoke",
        issuedAt: "2026-10-27T12:00:00Z",
        signerKey: x.newKey,
        publisherId: "acme",
        keyFingerprint: publisherKeyFingerprint(x.newKey),
        reason: "leaked",
      },
      nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).secretKey.slice(0, 32),
    );
    await expect(
      installFromRegistry(x.deps, {
        id: "com.example.rot",
        acceptPublisherKey: publisherKeyFingerprint(x.newKey),
      }),
    ).rejects.toThrow("ERR_EXTENSION_KEY_REVOKED");
    expect(x.asked()).toBe(0);
  });

  test("source pins: every door decides through publisherKeyDecision; the old any-different-key check is gone", async () => {
    const files = await readDirFiles("packages/gateway/src");
    expect(
      files.filter((f) => /\bvaultPublisherKeyConflicts\b/.test(stripComments(f.contents))),
    ).toEqual([]);
    const callers = files
      .filter((f) => !f.rel.endsWith(".test.ts"))
      .filter((f) => /\bpublisherKeyDecision\(/.test(stripComments(f.contents)))
      .map((f) => f.rel)
      .filter((r) => r !== "extensions/trust/publisher-key-decision.ts")
      .sort();
    expect(callers).toEqual([
      "extensions/auto-update-init.ts",
      "extensions/migration/migration-engine.ts",
      "extensions/registry/install-from-registry.ts",
      "extensions/registry/registry-dependency-fetcher.ts",
      "extensions/registry/registry-update-source.ts",
    ]);
  });
});
