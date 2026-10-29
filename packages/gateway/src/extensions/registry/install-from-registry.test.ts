import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  publisherKeyFingerprint,
  RegistryError,
  signTrustStatement,
  type UnsignedTrustStatement,
} from "@nimbus-dev/registry-format";
import * as tar from "tar";
import nacl from "tweetnacl";
import { assertInstalled } from "../../../test/helpers/assert-installed.ts";
import { isInstalledAsDependency, listExtensions } from "../../automation/extension-store.ts";
import { consentDisplayPayload } from "../../engine/executor.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import { forwardDeps } from "../dependency-store.ts";
import {
  type ExtensionInstallApprovalRequest,
  installExtensionFromLocalDirectory,
  rollbackFailuresOf,
} from "../install-from-local.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import { decodeBase64 } from "../verify-signature.ts";
import {
  buildMultiExtensionRegistry,
  buildTestRegistry,
  PUBLISHER_SEED,
  ROOT_SEED,
  resignIndex,
  type TestRegistry,
  type TestVersion,
} from "./__fixtures__/build-test-registry.ts";
import {
  fetchVerifiedRegistryPackage,
  type InstallFromRegistryDeps,
  installFromRegistry,
  installVerifiedRegistryPackage,
} from "./install-from-registry.ts";
import {
  createRegistryDependencyResolver,
  type RegistryDependencyResolver,
} from "./registry-dependency-fetcher.ts";
import { getExtensionSource, insertRegistry } from "./registry-store.ts";

const ID = "com.example.tool";
const NOW = Date.parse("2026-10-18T12:00:00Z");

let db: Database;
let tmp: string;
let regDir: string;
let extensionsDir: string;
let vault: MockVault;
let reg: TestRegistry;
let asked: ExtensionInstallApprovalRequest[];
let fetchCalls: number;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-instreg-"));
  regDir = join(tmp, "registry");
  extensionsDir = join(tmp, "extensions");
  vault = new MockVault();
  asked = [];
  fetchCalls = 0;
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function setup(
  versions: Parameters<typeof buildTestRegistry>[1]["versions"],
  extra: Partial<Parameters<typeof buildTestRegistry>[1]> = {},
): Promise<void> {
  reg = await buildTestRegistry(regDir, { id: ID, versions, ...extra });
  insertRegistry(db, {
    name: "main",
    url: regDir,
    rootKey: reg.rootKey,
    rootFingerprint: publisherKeyFingerprint(reg.rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: NOW,
    lastIndexSha256: null,
  });
}

function deps(approve = true): InstallFromRegistryDeps {
  return {
    db,
    extensionsDir,
    vault,
    fetch: {
      fetchFn: () => {
        fetchCalls += 1;
        return Promise.reject(new Error("unexpected network"));
      },
      enforceAirGap: () => false,
      now: () => NOW,
      production: false,
      // Neutral test default: never reach the real official registry host.
      builtin: null,
    },
    approve: async (r: ExtensionInstallApprovalRequest) => {
      asked.push(r);
      return approve;
    },
  };
}

function resetInstalled(): void {
  db.run("DELETE FROM extension");
  rmSync(extensionsDir, { recursive: true, force: true });
}

describe("installFromRegistry", () => {
  test("installs from a local-folder registry and records source registry, fingerprint, channel", async () => {
    await setup([{ version: "1.0.0" }]);
    const out = await installFromRegistry(deps(), { id: ID });
    expect(out.id).toBe(ID);
    assertInstalled(out);
    expect(out.sourceRegistry).toBe("main");
    expect(existsSync(join(extensionsDir, ID, "dist", "index.js"))).toBe(true);
    expect(getExtensionSource(db, ID)).toEqual({
      registry: "main",
      rootFingerprint: publisherKeyFingerprint(reg.rootKey),
      channel: "stable",
    });
    expect(out.entryHash).toBe(reg.entryHashOf("1.0.0"));
    expect(fetchCalls).toBe(0);
  });

  test("the prompt shows the registry's provenance only when the signed manifest names its repository (PR 4c)", async () => {
    const provenance = {
      sourceRepository: "example/tool",
      commit: "c".repeat(40),
      workflow: ".github/workflows/release.yml@refs/tags/v1.0.0",
      runner: "github-hosted" as const,
      verifiedAt: "2026-10-01T00:00:00Z",
    };
    const withProvenance = (): void => {
      const path = join(regDir, "index.json");
      const index = JSON.parse(readFileSync(path, "utf8")) as {
        extensions: Record<string, { versions: Record<string, Record<string, unknown>> }>;
      };
      const v = index.extensions[ID]?.versions["1.0.0"] as Record<string, unknown>;
      v["provenance"] = provenance;
      resignIndex(path, index as unknown as Record<string, unknown>);
    };
    await setup([{ version: "1.0.0" }], { manifestExtra: { repository: "example/tool" } });
    withProvenance();
    await installFromRegistry(deps(), { id: ID });
    expect(asked[0]?.provenance).toEqual(provenance);
    expect(asked[0]?.provenanceNote).toBe(
      "Provenance verified by main: built from example/tool at cccccccccccc by .github/workflows/release.yml@refs/tags/v1.0.0",
    );
    // The same recorded provenance under a manifest naming another repository: not shown.
    resetInstalled();
    rmSync(regDir, { recursive: true, force: true });
    db.run("DELETE FROM extension_registry");
    asked = [];
    await setup([{ version: "1.0.0" }], { manifestExtra: { repository: "evil/tool" } });
    withProvenance();
    await installFromRegistry(deps(), { id: ID });
    expect(asked[0]?.provenance).toBeUndefined();
    expect(asked[0]?.provenanceNote).toBeUndefined();
  });

  test("prompt payload carries sourceRegistry and rootFingerprint, never a *Key field", async () => {
    await setup([{ version: "1.0.0" }]);
    await installFromRegistry(deps(), { id: ID });
    expect(asked).toHaveLength(1);
    const req = asked[0] as ExtensionInstallApprovalRequest;
    expect(req.sourceRegistry).toBe("main");
    expect(req.rootFingerprint).toBe(publisherKeyFingerprint(reg.rootKey));
    expect(req.publisher?.fingerprint).toBe(publisherKeyFingerprint(reg.publisherKey));
    const names = [...Object.keys(req), ...Object.keys(req.publisher ?? {})];
    expect(names.filter((n) => n.toLowerCase().includes("key"))).toEqual([]);
  });

  test("a denied approval installs nothing and records no source", async () => {
    await setup([{ version: "1.0.0" }]);
    await expect(installFromRegistry(deps(false), { id: ID })).rejects.toThrow(
      "ERR_EXTENSION_INSTALL_NOT_APPROVED",
    );
    expect(listExtensions(db)).toHaveLength(0);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
  });

  test("tampered package.tgz fails HASH_MISMATCH before extraction", async () => {
    await setup([{ version: "1.0.0" }]);
    const p = join(regDir, "extensions", ID, "1.0.0", "package.tgz");
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(p, bytes);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      "ERR_REGISTRY_HASH_MISMATCH",
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("manifest publisher differing from the index refuses", async () => {
    const other = encodeBase64(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    await setup([{ version: "1.0.0" }], { indexPublisherKey: other });
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      "ERR_REGISTRY_MANIFEST_MISMATCH",
    );
    expect(asked).toHaveLength(0);
  });

  test("Vault holding another key for the publisher refuses PUBLISHER_KEY_CONFLICT", async () => {
    await setup([{ version: "1.0.0" }]);
    await writePublisherKey(
      vault,
      "acme",
      nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
    );
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      "ERR_REGISTRY_PUBLISHER_KEY_CONFLICT",
    );
    expect(asked).toHaveLength(0);
  });

  test("already installed refuses with the update hint", async () => {
    await setup([{ version: "1.0.0" }]);
    await installFromRegistry(deps(), { id: ID });
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_ALREADY_INSTALLED.*nimbus extension update/,
    );
  });

  test("missing dependency refuses and fetches nothing transitively", async () => {
    await setup([{ version: "1.0.0", dependsOn: { "com.example.dep": "^1.0.0" } }]);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_INSTALL_REFUSED/,
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
    expect(existsSync(join(extensionsDir, "com.example.dep"))).toBe(false);
  });

  test("a remote registry is asked only for the root's manifest and package, nothing transitive", async () => {
    await setup([{ version: "1.0.0", dependsOn: { "com.example.dep": "^1.0.0" } }]);
    db.run("UPDATE extension_registry SET url = 'https://reg.example/r' WHERE name = 'main'");
    const urls: string[] = [];
    const d = deps();
    d.fetch.fetchFn = (url: string) => {
      urls.push(url);
      const rel = url.replace("https://reg.example/r/", "");
      return Promise.resolve(new Response(readFileSync(join(regDir, rel))));
    };
    await expect(installFromRegistry(d, { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_INSTALL_REFUSED/,
    );
    expect(urls).toEqual([
      "https://reg.example/r/index.json",
      `https://reg.example/r/extensions/${ID}/1.0.0/manifest.json`,
      `https://reg.example/r/extensions/${ID}/1.0.0/package.tgz`,
    ]);
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("the nimbus-reg temp dir is gone after a success and after a refusal", async () => {
    await setup([{ version: "1.0.0" }]);
    const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith("nimbus-reg-")));
    await installFromRegistry(deps(), { id: ID });
    resetInstalled();
    await expect(installFromRegistry(deps(false), { id: ID })).rejects.toThrow(
      "ERR_EXTENSION_INSTALL_NOT_APPROVED",
    );
    const after = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("nimbus-reg-") && !before.has(n),
    );
    expect(after).toEqual([]);
  });

  test("an index entryHash that does not match the packaged entry is refused before any prompt", async () => {
    await setup([{ version: "1.0.0" }], { entryHashOverride: "0".repeat(64) });
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_HASH_MISMATCH.*entry file/,
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
  });

  test("a packaged manifest that differs from the signed manifest is refused before any prompt", async () => {
    await setup([{ version: "1.0.0" }]);
    const base = join(regDir, "extensions", ID, "1.0.0");
    // Rebuild the package around a different (still well-formed) manifest, and re-hash it in the index.
    const alt = join(tmp, "alt");
    mkdirSync(join(alt, "pkg", "dist"), { recursive: true });
    writeFileSync(join(alt, "pkg", "dist", "index.js"), "x");
    writeFileSync(join(alt, "pkg", "nimbus.extension.json"), '{"id":"other"}');
    await tar.c({ gzip: true, file: join(base, "package.tgz"), cwd: alt }, ["pkg"]);
    const idxPath = join(regDir, "index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    idx.extensions[ID].versions["1.0.0"].packageSha256 = createHash("sha256")
      .update(readFileSync(join(base, "package.tgz")))
      .digest("hex");
    resignIndex(idxPath, idx);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_HASH_MISMATCH.*packaged manifest/,
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("a manifest signature that does not verify carries ERR_REGISTRY_SIGNATURE_INVALID", async () => {
    await setup([{ version: "1.0.0" }], { badManifestSignature: true });
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      "ERR_REGISTRY_SIGNATURE_INVALID",
    );
    expect(asked).toHaveLength(0);
  });

  test("stable is the default; beta picks the newest of stable and beta; --version is exact", async () => {
    await setup([
      { version: "1.0.0" },
      { version: "1.1.0" },
      { version: "1.2.0-beta.1", channel: "beta" },
      { version: "2.0.0", channel: "beta" },
    ]);
    const stable = await installFromRegistry(deps(), { id: ID });
    expect(stable.version).toBe("1.1.0");
    expect(getExtensionSource(db, ID)?.channel).toBe("stable");

    resetInstalled();
    const beta = await installFromRegistry(deps(), { id: ID, channel: "beta" });
    expect(beta.version).toBe("2.0.0");
    expect(getExtensionSource(db, ID)?.channel).toBe("beta");

    resetInstalled();
    const exact = await installFromRegistry(deps(), { id: ID, version: "1.0.0" });
    expect(exact.version).toBe("1.0.0");
    resetInstalled();
    await expect(installFromRegistry(deps(), { id: ID, version: "9.9.9" })).rejects.toThrow(
      "ERR_REGISTRY_VERSION_NOT_FOUND",
    );
  });

  test("records the REQUESTED channel, not the resolved version's (spec § 8.1)", async () => {
    await setup([{ version: "1.0.0" }, { version: "0.9.0-beta.1", channel: "beta" }]);
    // --channel beta whose newest pick across stable and beta is a STABLE version keeps tracking beta.
    const betaToStable = await installFromRegistry(deps(), { id: ID, channel: "beta" });
    expect(betaToStable.version).toBe("1.0.0");
    expect(getExtensionSource(db, ID)?.channel).toBe("beta");

    // --version of a beta build with no --channel records the default, stable.
    resetInstalled();
    const exactBeta = await installFromRegistry(deps(), { id: ID, version: "0.9.0-beta.1" });
    expect(exactBeta.version).toBe("0.9.0-beta.1");
    expect(getExtensionSource(db, ID)?.channel).toBe("stable");
  });
});

/** Rewrites one version's artifact, re-hashes it in the index and re-signs the index with the root. */
function replaceArtifact(
  version: string,
  file: "manifest.json" | "package.tgz",
  bytes: Uint8Array | string,
): void {
  const p = join(regDir, "extensions", ID, version, file);
  writeFileSync(p, bytes);
  const idxPath = join(regDir, "index.json");
  const idx = JSON.parse(readFileSync(idxPath, "utf8"));
  const key = file === "manifest.json" ? "manifestSha256" : "packageSha256";
  idx.extensions[ID].versions[version][key] = createHash("sha256")
    .update(readFileSync(p))
    .digest("hex");
  resignIndex(idxPath, idx);
}

describe("installFromRegistry refusals before any prompt", () => {
  test("a beta-only extension is not found on the default channel, with a hint naming the flags", async () => {
    await setup([{ version: "0.1.0-beta.1", channel: "beta" }]);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_VERSION_NOT_FOUND.*no stable version.*\(pass --channel beta or --version\)/,
    );
    expect(asked).toHaveLength(0);
    // The same extension resolves once beta is asked for.
    const beta = await installFromRegistry(deps(), { id: ID, channel: "beta" });
    expect(beta.version).toBe("0.1.0-beta.1");
  });

  test("a manifest.json whose bytes differ from the signed hash refuses HASH_MISMATCH", async () => {
    await setup([{ version: "1.0.0" }]);
    const p = join(regDir, "extensions", ID, "1.0.0", "manifest.json");
    writeFileSync(p, `${readFileSync(p, "utf8")} `);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_HASH_MISMATCH.*the manifest of/,
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("a signed-hash manifest that is not a valid manifest refuses MANIFEST_INVALID", async () => {
    await setup([{ version: "1.0.0" }]);
    replaceArtifact("1.0.0", "manifest.json", "{ not json");
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_MANIFEST_INVALID.*com\.example\.tool@1\.0\.0/,
    );
    expect(asked).toHaveLength(0);
  });

  test("a manifest declaring another version than the index entry refuses MANIFEST_MISMATCH", async () => {
    await setup([{ version: "1.0.0" }]);
    const p = join(regDir, "extensions", ID, "1.0.0", "manifest.json");
    const m = JSON.parse(readFileSync(p, "utf8"));
    replaceArtifact("1.0.0", "manifest.json", JSON.stringify({ ...m, version: "1.0.1" }));
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_MANIFEST_MISMATCH.*declares com\.example\.tool@1\.0\.1, not com\.example\.tool@1\.0\.0/,
    );
    expect(asked).toHaveLength(0);
  });

  test("a signed-hash package that is not a gzip tarball refuses EXTRACT_FAILED", async () => {
    await setup([{ version: "1.0.0" }]);
    replaceArtifact("1.0.0", "package.tgz", new TextEncoder().encode("definitely not a tarball"));
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_EXTRACT_FAILED.*could not be extracted/,
    );
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toHaveLength(0);
  });

  test("a Vault already holding the SAME publisher key installs without a conflict", async () => {
    await setup([{ version: "1.0.0" }]);
    await writePublisherKey(vault, "acme", nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey);
    const out = await installFromRegistry(deps(), { id: ID });
    expect(out.version).toBe("1.0.0");
    assertInstalled(out);
    expect(out.publisher.id).toBe("acme");
    expect(listExtensions(db).map((r) => r.id)).toEqual([ID]);
  });
});

describe("installFromRegistry refuses blocked code (I48)", () => {
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
  const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
  const PUBLISHER_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey);

  async function nimbus(statement: UnsignedTrustStatement): Promise<void> {
    const s = await signTrustStatement(statement, NIMBUS_SEED);
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: NIMBUS_KEY }, 1);
  }
  const takedown = (versions: string[]) =>
    nimbus({
      kind: "extension.takedown",
      issuedAt: "2026-10-26T12:00:00Z",
      signerKey: NIMBUS_KEY,
      extensionId: ID,
      publisherId: "acme",
      versions,
      reason: "malware",
    });

  test("the default pick skips a taken-down newest version for the clean one below it", async () => {
    await setup([{ version: "1.0.9" }, { version: "1.1.0" }]);
    await takedown(["1.1.0"]);
    expect((await installFromRegistry(deps(), { id: ID })).version).toBe("1.0.9");
  });

  test("an explicit taken-down version is refused before its manifest is even read", async () => {
    await setup([{ version: "1.0.9" }, { version: "1.1.0" }]);
    await takedown(["1.1.0"]);
    // Were the manifest read first, this would fail as a fetch error, not as a takedown.
    rmSync(join(regDir, "extensions", ID, "1.1.0"), { recursive: true, force: true });
    await expect(installFromRegistry(deps(), { id: ID, version: "1.1.0" })).rejects.toThrow(
      "ERR_EXTENSION_TAKEN_DOWN",
    );
    expect(asked).toEqual([]);
    expect(listExtensions(db)).toEqual([]);
  });

  test("a revoked publisher key refuses every version before the owner is asked", async () => {
    await setup([{ version: "1.0.9" }, { version: "1.1.0" }]);
    await nimbus({
      kind: "key.revoke",
      issuedAt: "2026-10-26T12:00:00Z",
      signerKey: NIMBUS_KEY,
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(PUBLISHER_KEY),
      reason: "leaked",
    });
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      "ERR_EXTENSION_KEY_REVOKED",
    );
    expect(asked).toEqual([]);
  });

  test("a takedown scoped to ANOTHER registry does not reach this one", async () => {
    await setup([{ version: "1.1.0" }]);
    const otherSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 90);
    const otherRoot = encodeBase64(nacl.sign.keyPair.fromSeed(otherSeed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: otherRoot,
        extensionId: ID,
        publisherId: "acme",
        versions: "*",
        reason: "not yours",
      },
      otherSeed,
    );
    recordTrustStatements(
      db,
      [s],
      {
        kind: "registry",
        name: "other",
        rootKey: otherRoot,
        rootFingerprint: publisherKeyFingerprint(otherRoot),
        listedPublisherKeys: new Map(),
      },
      1,
    );
    expect((await installFromRegistry(deps(), { id: ID })).version).toBe("1.1.0");
  });
});

describe("installFromRegistry follows a publisher's key rotation (spec R5, R8)", () => {
  const PUB = nacl.sign.keyPair.fromSeed(PUBLISHER_SEED);
  const PUB_KEY = encodeBase64(PUB.publicKey);
  const OLD_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 150);
  const OLD = nacl.sign.keyPair.fromSeed(OLD_SEED);
  const OLD_KEY = encodeBase64(OLD.publicKey);
  const OTHER_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 180);
  const OTHER_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(OTHER_SEED).publicKey);
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 210);
  const NIMBUS_KEY = encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);

  async function rotate(toKey: string): Promise<void> {
    const s = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: OLD_KEY,
        publisherId: "acme",
        fromKey: OLD_KEY,
        toKey,
      },
      OLD_SEED,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: NIMBUS_KEY }, 1);
  }

  beforeEach(async () => {
    // The machine trusts only the publisher's OLD key; the index now names the new one.
    await writePublisherKey(vault, "acme", OLD.publicKey);
  });

  test("a rotation from the trusted key installs, and the prompt states the change", async () => {
    await setup([{ version: "1.0.0" }]);
    await rotate(PUB_KEY);
    await installFromRegistry(deps(), { id: ID });
    expect(asked[0]).toMatchObject({
      publisherChange: {
        from: [publisherKeyFingerprint(OLD_KEY)],
        to: publisherKeyFingerprint(PUB_KEY),
        via: "rotation",
      },
    });
    expect(asked[0]?.publisherChangeNote).toContain("via the publisher's signed rotation");
    // Both keys are now trusted; the row records the new one.
    expect(listExtensions(db)[0]?.publisher_key_fingerprint).toBe(publisherKeyFingerprint(PUB_KEY));
  });

  test("with no rotation the new key is a conflict, refused before the owner is asked", async () => {
    await setup([{ version: "1.0.0" }]);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_PUBLISHER_KEY_CONFLICT.*--accept-publisher-key/,
    );
    expect(asked).toEqual([]);
  });

  test("a fork (two rotations from the trusted key) is a conflict", async () => {
    await setup([{ version: "1.0.0" }]);
    await rotate(PUB_KEY);
    await rotate(OTHER_KEY);
    await expect(installFromRegistry(deps(), { id: ID })).rejects.toThrow(
      /ERR_REGISTRY_PUBLISHER_KEY_CONFLICT.*more than one key/,
    );
  });

  test("--accept-publisher-key with the exact fingerprint installs, and the prompt says it is unvouched", async () => {
    await setup([{ version: "1.0.0" }]);
    await installFromRegistry(deps(), {
      id: ID,
      acceptPublisherKey: publisherKeyFingerprint(PUB_KEY),
    });
    expect(asked[0]?.publisherChange?.via).toBe("owner");
    expect(asked[0]?.publisherChangeNote).toBe(
      `publisher key CHANGED from ${publisherKeyFingerprint(OLD_KEY)} to ${publisherKeyFingerprint(PUB_KEY)}, not vouched for by any rotation or by Nimbus`,
    );
  });

  test("--accept-publisher-key naming another fingerprint is refused, not taken as acceptance", async () => {
    await setup([{ version: "1.0.0" }]);
    await expect(
      installFromRegistry(deps(), { id: ID, acceptPublisherKey: "0".repeat(32) }),
    ).rejects.toThrow(/--accept-publisher-key names 0{32}/);
    expect(asked).toEqual([]);
  });

  test("an unchanged key states no change", async () => {
    await setup([{ version: "1.0.0" }]);
    await writePublisherKey(vault, "acme", PUB.publicKey); // replaces the legacy key: now trusted
    await installFromRegistry(deps(), { id: ID });
    expect(asked[0]?.publisherChange).toBeUndefined();
  });
});

describe("installFromRegistry installs a dependency plan", () => {
  const DEP = "com.example.dep";
  const DEP2 = "com.example.dep2";
  const PLAN_PREFIX = "nimbus-plan-";
  /** Remote registries served from folders by the fake fetch: `https://<name>.test/`. */
  const served = new Map<string, string>();
  let urls: string[];
  /** This test's own plan staging root: never the shared `os.tmpdir()` other workers write to. */
  let planRoot: string;
  /** The plan staging root's entries when a dependency package was fetched (staging is under way). */
  let stagingWhileFetching: string[][];

  beforeEach(() => {
    // The plan installer records each edge's registry and the dependency marker (V78), and each
    // package's kind (V79).
    db.close();
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 79);
    served.clear();
    urls = [];
    planRoot = join(tmp, "plan-staging");
    mkdirSync(planRoot, { recursive: true });
    stagingWhileFetching = [];
  });

  async function addRemote(name: string, exts: Record<string, TestVersion[]>): Promise<string> {
    const dir = join(tmp, `reg-${name}`);
    const keys = await buildMultiExtensionRegistry(dir, exts);
    served.set(name, dir);
    insertRegistry(db, {
      name,
      url: `https://${name}.test/`,
      rootKey: keys.rootKey,
      rootFingerprint: publisherKeyFingerprint(keys.rootKey),
      lastSequence: 0,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: NOW,
      lastIndexSha256: null,
    });
    return dir;
  }

  function planDeps(approve = true): InstallFromRegistryDeps {
    const d = deps(approve);
    d.planStagingRoot = planRoot;
    d.fetch.fetchFn = (url: string) => {
      urls.push(url);
      if (url.endsWith(`/${DEP}/1.0.0/package.tgz`)) {
        stagingWhileFetching.push(readdirSync(planRoot));
      }
      const u = new URL(url);
      const dir = served.get(u.hostname.replace(/\.test$/, ""));
      if (dir === undefined) return Promise.resolve(new Response("down", { status: 503 }));
      try {
        return Promise.resolve(
          new Response(readFileSync(join(dir, ...u.pathname.split("/").filter(Boolean)))),
        );
      } catch {
        return Promise.resolve(new Response("missing", { status: 404 }));
      }
    };
    return d;
  }

  /** Root `com.example.tool` → `com.example.dep`, both in `main`. */
  function mainWithDep(): Promise<string> {
    return addRemote("main", {
      [ID]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
  }

  function installedIds(): string[] {
    return listExtensions(db).map((r) => r.id);
  }

  /** Staging happened under `planRoot` (one plan directory), and nothing of it is left. */
  function expectPlanStagingUsedAndRemoved(): void {
    expect(stagingWhileFetching.length).toBeGreaterThan(0);
    for (const entries of stagingWhileFetching) {
      expect(entries).toHaveLength(1);
      expect(entries[0]?.startsWith(PLAN_PREFIX)).toBe(true);
    }
    expect(readdirSync(planRoot)).toEqual([]);
  }

  async function codeOf(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return (e as { code?: unknown }).code ?? e;
    }
    return undefined;
  }

  const PUBLISHER_FP = publisherKeyFingerprint(
    encodeBase64(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey),
  );

  test("a missing same-registry dependency is fetched, approved once and installed first", async () => {
    await mainWithDep();
    const out = await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    expect(asked).toHaveLength(1);
    const req = asked[0] as ExtensionInstallApprovalRequest;
    expect(req.plan?.map((p) => p.id)).toEqual([DEP, ID]);
    expect(req.plan?.[0]).toMatchObject({
      id: DEP,
      version: "1.0.0",
      registry: "main",
      registryUrl: "https://main.test/",
      requiredBy: [{ from: ID, range: "^1.0.0" }],
      newlyInstalled: true,
      publisher: { id: "acme", fingerprint: PUBLISHER_FP },
    });
    expect(req.plan?.[1]).toMatchObject({ id: ID, requiredBy: [], newlyInstalled: true });
    expect(req.installs).toEqual([
      { id: ID, version: "1.0.0" },
      { id: DEP, version: "1.0.0" },
    ]);
    expect(req.planText).toContain("This install adds 2 packages:");
    expect(req.planText).toContain(`${DEP}@1.0.0 (${ID} needs ^1.0.0) — registry main`);
    expect(req.planPermissions).toEqual({ network: [], filesystem: { read: [], write: [] } });

    expect(installedIds()).toEqual([DEP, ID]);
    expect(getExtensionSource(db, DEP)).toEqual({
      registry: "main",
      rootFingerprint: publisherKeyFingerprint(
        encodeBase64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey),
      ),
      channel: "stable",
    });
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(isInstalledAsDependency(db, ID)).toBe(false);
    expect(forwardDeps(db, ID)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
    assertInstalled(out);
    expect(out.dependencies).toEqual([{ id: DEP, version: "1.0.0", registry: "main" }]);
    expect(existsSync(join(extensionsDir, DEP, "dist", "index.js"))).toBe(true);
  });

  test("the approval lists the plan's connector requirements before anything is staged", async () => {
    await addRemote("main", {
      [ID]: [
        {
          version: "1.0.0",
          dependsOn: { [DEP]: "^1.0.0" },
          requires: { connectors: ["github"] },
        },
      ],
      [DEP]: [{ version: "1.0.0", requires: { connectors: ["slack"] } }],
    });
    const d = planDeps();
    const answer = d.approve;
    let atApproval: { installed: string[]; staged: string[]; extensionsDir: boolean } | undefined;
    d.approve = (r) => {
      atApproval = {
        installed: installedIds(),
        staged: readdirSync(planRoot),
        extensionsDir: existsSync(extensionsDir),
      };
      return answer(r);
    };
    await installFromRegistry(d, { id: ID, registry: "main" });
    expect(atApproval).toEqual({ installed: [], staged: [], extensionsDir: false });
    const req = asked[0] as ExtensionInstallApprovalRequest;
    expect(req.planText).toContain("This install adds 2 packages:");
    expect(req.planText).toEndWith(
      [
        "Needs:",
        "  github: not connected — run: nimbus connector auth github --token <token>",
        "  slack: not connected — run: nimbus connector auth slack",
      ].join("\n"),
    );
    expect(req.connectorRequirements?.map((r) => [r.connector, r.state, r.requiredBy])).toEqual([
      ["github", "not_connected", [ID]],
      ["slack", "not_connected", [DEP]],
    ]);
    expect(installedIds()).toEqual([DEP, ID]);
  });

  test("a connector whose continuity owner this plan installs is never connected in the approval", async () => {
    await addRemote("main", {
      [ID]: [
        {
          version: "1.0.0",
          dependsOn: { [DEP]: "^1.0.0" },
          requires: { connectors: ["legacyx"] },
        },
      ],
      [DEP]: [{ version: "1.0.0" }],
    });
    const publisherKey = encodeBase64(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey);
    const d = planDeps();
    d.continuityTable = [
      {
        legacyServiceId: "legacyx",
        extensionId: DEP,
        publisherKey,
        sourceRootFingerprint: publisherKeyFingerprint(
          encodeBase64(nacl.sign.keyPair.fromSeed(ROOT_SEED).publicKey),
        ),
        // audit-ignore-next-line D11-vault-key (test continuity entry's legacy key)
        credentials: { token: "legacyx.token" },
        expectedPermissions: { network: [], read: [], write: [] },
        itemTypes: [],
      },
    ];
    // The legacy key alone must not make the plan's own owner read as connected.
    await vault.set("legacyx.token", "legacy-value");
    await installFromRegistry(d, { id: ID, registry: "main" });
    const req = asked[0] as ExtensionInstallApprovalRequest;
    expect(req.connectorRequirements).toEqual([
      {
        connector: "legacyx",
        state: "not_connected",
        owner: { kind: "extension", extensionId: DEP },
        fix: [`nimbus extension approve ${DEP}`],
        interactive: true,
        requiredBy: [ID],
      },
    ]);
    expect(req.planText).toEndWith(
      ["Needs:", `  legacyx: not connected — run: nimbus extension approve ${DEP}`].join("\n"),
    );
  });

  test("a failing requirement computation leaves the Needs block out and the plan installs", async () => {
    await addRemote("main", {
      [ID]: [
        {
          version: "1.0.0",
          dependsOn: { [DEP]: "^1.0.0" },
          requires: { connectors: ["github"] },
        },
      ],
      [DEP]: [{ version: "1.0.0" }],
    });
    const d = planDeps();
    d.requirementStatuses = () => Promise.reject(new Error("requirements unavailable"));
    await installFromRegistry(d, { id: ID, registry: "main" });
    const req = asked[0] as ExtensionInstallApprovalRequest;
    expect(req.planText).toContain("This install adds 2 packages:");
    expect(req.planText).not.toContain("Needs:");
    expect(req.connectorRequirements).toBeUndefined();
    expect(installedIds()).toEqual([DEP, ID]);
  });

  test("a dependency from a named, added registry installs from it", async () => {
    await addRemote("main", {
      [ID]: [
        {
          version: "1.0.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://other.test/" } },
        },
      ],
    });
    await addRemote("other", { [DEP]: [{ version: "1.0.0" }] });
    const out = await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    expect(getExtensionSource(db, DEP)?.registry).toBe("other");
    expect(asked[0]?.plan?.[0]).toMatchObject({
      id: DEP,
      registry: "other",
      registryUrl: "https://other.test/",
    });
    expect(forwardDeps(db, ID)).toEqual([{ id: DEP, range: "^1.0.0", registry: "other" }]);
    assertInstalled(out);
    expect(out.dependencies).toEqual([{ id: DEP, version: "1.0.0", registry: "other" }]);
    expect(urls.filter((u) => u.startsWith("https://main.test/") && u.includes(DEP))).toEqual([]);
    expect(urls.filter((u) => u.startsWith("https://other.test/") && u.includes(DEP))).toEqual([
      `https://other.test/extensions/${DEP}/1.0.0/manifest.json`,
      `https://other.test/extensions/${DEP}/1.0.0/package.tgz`,
    ]);
  });

  test("a dependency from a registry that is not added is refused before the prompt", async () => {
    await addRemote("main", {
      [ID]: [
        {
          version: "1.0.0",
          dependsOn: { [DEP]: { range: "^1.0.0", registry: "https://nowhere.test/" } },
        },
      ],
    });
    expect(await codeOf(installFromRegistry(planDeps(), { id: ID, registry: "main" }))).toBe(
      "ERR_DEPENDENCY_REGISTRY_NOT_ADDED",
    );
    expect(asked).toHaveLength(0);
    expect(installedIds()).toEqual([]);
    expect(urls.filter((u) => u.includes("nowhere.test"))).toEqual([]);
  });

  test("a locally installed copy does not satisfy a registry dependency", async () => {
    await mainWithDep();
    const local = join(tmp, "local-dep");
    mkdirSync(join(local, "dist"), { recursive: true });
    writeFileSync(join(local, "dist", "index.js"), "export const v = 1;");
    writeFileSync(
      join(local, "nimbus.extension.json"),
      JSON.stringify({ id: DEP, version: "1.0.0", entry: "dist/index.js", permissions: {} }),
    );
    await installExtensionFromLocalDirectory({ db, extensionsDir, sourcePath: local });
    expect(await codeOf(installFromRegistry(planDeps(), { id: ID, registry: "main" }))).toBe(
      "ERR_DEPENDENCY_SOURCE_MISMATCH",
    );
    expect(asked).toHaveLength(0);
    expect(installedIds()).toEqual([DEP]);
  });

  test("an installed same-registry dependency is reused, not fetched", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: DEP, registry: "main" });
    const depManifestRows = (): number =>
      (
        db
          .query(
            "SELECT COUNT(*) AS n FROM egress_ledger WHERE method = 'registry.manifest' AND payload_summary LIKE ?",
          )
          .get(`%${DEP}%`) as { n: number }
      ).n;
    const before = depManifestRows();
    expect(before).toBe(1);
    urls = [];
    asked = [];
    const out = await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    expect(depManifestRows()).toBe(before);
    expect(urls.filter((u) => u.includes(DEP))).toEqual([]);
    expect(asked[0]?.plan?.[0]).toMatchObject({ id: DEP, newlyInstalled: false });
    expect(asked[0]?.planText).toContain(
      `Already installed and reused: ${DEP}@1.0.0 (registry main)`,
    );
    assertInstalled(out);
    expect(out.dependencies).toEqual([]);
    // Installed by the owner's own request, so it is not marked as a dependency.
    expect(isInstalledAsDependency(db, DEP)).toBe(false);
    expect(forwardDeps(db, ID)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
  });

  const egressRows = (): number =>
    (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;

  test("an explicit registry install of a dependency promotes it", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    const rowBefore = listExtensions(db).find((r) => r.id === DEP);
    const ledgerBefore = egressRows();
    urls = [];
    asked = [];
    const out = await installFromRegistry(planDeps(), { id: DEP });
    expect(out).toEqual({ id: DEP, version: "1.0.0", promoted: true });
    expect(urls).toEqual([]);
    expect(egressRows()).toBe(ledgerBefore);
    expect(asked).toHaveLength(0);
    expect(isInstalledAsDependency(db, DEP)).toBe(false);
    // Only the marker moved: the installed copy and its edges are untouched.
    expect(listExtensions(db).find((r) => r.id === DEP)).toEqual(rowBefore);
    expect(forwardDeps(db, ID)).toEqual([{ id: DEP, range: "^1.0.0", registry: "main" }]);
  });

  test("a registry install naming the dependency's own registry and version promotes it", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    const out = await installFromRegistry(planDeps(), {
      id: DEP,
      registry: "main",
      version: "1.0.0",
    });
    expect(out).toEqual({ id: DEP, version: "1.0.0", promoted: true });
    expect(isInstalledAsDependency(db, DEP)).toBe(false);
  });

  test("a registry install of a dependency asking another version or registry is still refused", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    urls = [];
    for (const req of [
      { id: DEP, version: "2.0.0" },
      { id: DEP, registry: "other" },
    ]) {
      expect(await codeOf(installFromRegistry(planDeps(), req))).toBe(
        "ERR_REGISTRY_ALREADY_INSTALLED",
      );
    }
    expect(urls).toEqual([]);
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
  });

  test("an explicit install of an explicitly installed package is still refused", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    const ledgerBefore = egressRows();
    asked = [];
    expect(await codeOf(installFromRegistry(planDeps(), { id: ID }))).toBe(
      "ERR_REGISTRY_ALREADY_INSTALLED",
    );
    expect(egressRows()).toBe(ledgerBefore);
    expect(asked).toHaveLength(0);
    expect(isInstalledAsDependency(db, ID)).toBe(false);
  });

  test("declining installs nothing", async () => {
    await mainWithDep();
    await expect(
      installFromRegistry(planDeps(false), { id: ID, registry: "main" }),
    ).rejects.toThrow("ERR_EXTENSION_INSTALL_NOT_APPROVED");
    expect(asked).toHaveLength(1);
    expect(installedIds()).toEqual([]);
    expect(existsSync(join(extensionsDir, DEP))).toBe(false);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
    // Nothing is staged for a declined plan.
    expect(readdirSync(planRoot)).toEqual([]);
    // The dependency's package is fetched only after approval.
    expect(urls.filter((u) => u.includes(`${DEP}/1.0.0/package.tgz`))).toEqual([]);
  });

  test("a dependency package that fails its hash after approval installs nothing", async () => {
    const dir = await mainWithDep();
    const p = join(dir, "extensions", DEP, "1.0.0", "package.tgz");
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    writeFileSync(p, bytes);
    expect(await codeOf(installFromRegistry(planDeps(), { id: ID, registry: "main" }))).toBe(
      "ERR_REGISTRY_HASH_MISMATCH",
    );
    expect(asked).toHaveLength(1);
    expect(installedIds()).toEqual([]);
    expect(existsSync(join(extensionsDir, DEP))).toBe(false);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
    expectPlanStagingUsedAndRemoved();
  });

  test("a root whose entry hash mismatches after its dependency installed rolls the dependency back", async () => {
    await mainWithDep();
    const d = planDeps();
    const pkg = await fetchVerifiedRegistryPackage(
      d,
      { id: ID, registry: "main" },
      join(tmp, "stage-root"),
    );
    expect(
      await codeOf(
        installVerifiedRegistryPackage(d, { ...pkg, entryHash: "0".repeat(64) }, "stable"),
      ),
    ).toBe("ERR_REGISTRY_HASH_MISMATCH");
    expect(asked).toHaveLength(1);
    expect(listExtensions(db)).toEqual([]);
    expect(forwardDeps(db, ID)).toEqual([]);
    expect(forwardDeps(db, DEP)).toEqual([]);
    expect(existsSync(join(extensionsDir, DEP))).toBe(false);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
  });

  test("a rollback step that fails is reported on the original error, and the other steps still run", async () => {
    await mainWithDep();
    const d = planDeps();
    const pkg = await fetchVerifiedRegistryPackage(
      d,
      { id: ID, registry: "main" },
      join(tmp, "stage-root"),
    );
    // Every rollback `clearDeps` now throws; nothing before the rollback reads this table.
    db.run("DROP TABLE extension_dependency");
    let err: unknown;
    try {
      await installVerifiedRegistryPackage(d, { ...pkg, entryHash: "0".repeat(64) }, "stable");
    } catch (e) {
      err = e;
    }
    // The original refusal stays the primary error: same class, same code.
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe("ERR_REGISTRY_HASH_MISMATCH");
    expect(rollbackFailuresOf(err).map((f) => [f.step, f.id])).toEqual([
      ["clearDeps", ID],
      ["clearDeps", DEP],
    ]);
    expect((err as Error).cause).toBeInstanceOf(AggregateError);
    // The row deletion and the directory removal ran anyway.
    expect(listExtensions(db)).toEqual([]);
    expect(existsSync(join(extensionsDir, DEP))).toBe(false);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
  });

  test("a failure installing the second dependency removes the first one's row and directory", async () => {
    await addRemote("main", {
      [ID]: [{ version: "1.0.0", dependsOn: { [DEP]: "^1.0.0", [DEP2]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
      [DEP2]: [{ version: "1.0.0" }],
    });
    const d = planDeps();
    const pkg = await fetchVerifiedRegistryPackage(
      d,
      { id: ID, registry: "main" },
      join(tmp, "stage-root"),
    );
    const resolver = createRegistryDependencyResolver(d, {
      reg: pkg.reg,
      channel: "stable",
      ...(pkg.index === undefined ? {} : { index: pkg.index }),
    });
    const stagedIds: string[] = [];
    const tampering: RegistryDependencyResolver = {
      ...resolver,
      async stage(nodes, intoDir) {
        const staged = await resolver.stage(nodes, intoDir);
        stagedIds.push(...staged.map((s) => s.id));
        // The second dependency's staged manifest no longer matches its signature: I16 fails at install.
        const second = staged[1];
        if (second === undefined) throw new Error("expected two staged dependencies");
        const mfPath = join(second.sourceRoot, "nimbus.extension.json");
        const mf = JSON.parse(readFileSync(mfPath, "utf8")) as Record<string, unknown>;
        writeFileSync(mfPath, JSON.stringify({ ...mf, name: "tampered" }));
        return staged;
      },
    };
    await expect(
      installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: pkg.sourceRoot,
        vault,
        publisherKey: decodeBase64(pkg.publisherKey),
        sourceRegistry: "main",
        rootFingerprint: pkg.rootFingerprint,
        approve: async (r) => {
          asked.push(r);
          return true;
        },
        registryPlan: { resolver: tampering, channel: "stable" },
        expectedRootEntryHash: pkg.entryHash,
      }),
    ).rejects.toThrow();
    // It was the second dependency's I16 check, at install, that refused.
    const failed = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'extension.signature_failed'")
      .all() as { action_json: string }[];
    expect(failed.map((r) => (JSON.parse(r.action_json) as { id: string }).id)).toEqual([DEP2]);
    expect(stagedIds).toEqual([DEP, DEP2]);
    expect(asked).toHaveLength(1);
    expect(listExtensions(db)).toEqual([]);
    expect(existsSync(join(extensionsDir, DEP))).toBe(false);
    expect(existsSync(join(extensionsDir, DEP2))).toBe(false);
    expect(existsSync(join(extensionsDir, ID))).toBe(false);
  });

  test("a newly installed dependency with no verified record is refused before the prompt", async () => {
    await mainWithDep();
    const d = planDeps();
    const pkg = await fetchVerifiedRegistryPackage(
      d,
      { id: ID, registry: "main" },
      join(tmp, "stage-root"),
    );
    const resolver = createRegistryDependencyResolver(d, {
      reg: pkg.reg,
      channel: "stable",
      ...(pkg.index === undefined ? {} : { index: pkg.index }),
    });
    // The solve still plans the dependency, but its verified record is gone: the prompt would
    // otherwise fall back to no publisher and no permissions, understating what is installed.
    const forgetful: RegistryDependencyResolver = { ...resolver, verified: () => undefined };
    let err: unknown;
    try {
      await installExtensionFromLocalDirectory({
        db,
        extensionsDir,
        sourcePath: pkg.sourceRoot,
        vault,
        publisherKey: decodeBase64(pkg.publisherKey),
        sourceRegistry: "main",
        rootFingerprint: pkg.rootFingerprint,
        approve: async (r) => {
          asked.push(r);
          return true;
        },
        registryPlan: { resolver: forgetful, channel: "stable" },
        expectedRootEntryHash: pkg.entryHash,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RegistryError);
    expect((err as RegistryError).code).toBe("ERR_REGISTRY_INSTALL_REFUSED");
    expect((err as RegistryError).message).toContain(`${DEP}@1.0.0`);
    expect(asked).toHaveLength(0);
    expect(listExtensions(db)).toEqual([]);
  });

  test("the consent display shows every plan field unredacted", async () => {
    await mainWithDep();
    await installFromRegistry(planDeps(), { id: ID, registry: "main" });
    const shown = consentDisplayPayload({
      type: "extension.install",
      payload: { ...(asked[0] as ExtensionInstallApprovalRequest) },
    });
    expect(JSON.stringify(shown?.["plan"])).not.toContain("[REDACTED]");
    expect(JSON.stringify(shown?.["planPermissions"])).not.toContain("[REDACTED]");
    expect(JSON.stringify(shown)).not.toContain("[REDACTED]");
    expect(shown?.["plan"]).toEqual(asked[0]?.plan);
    expect(shown?.["planText"]).toBeUndefined();
  });

  const PACK = "com.example.pack";
  const SUBPACK = "com.example.subpack";

  function kindOf(id: string): string | undefined {
    return listExtensions(db).find((r) => r.id === id)?.kind;
  }

  test("a registry starter pack installs with its members in one approval", async () => {
    const dir = await addRemote("main", {
      [PACK]: [
        {
          version: "1.0.0",
          starterPack: true,
          dependsOn: { [DEP]: "^1.0.0", [DEP2]: "^1.0.0" },
        },
      ],
      [DEP]: [{ version: "1.0.0" }],
      [DEP2]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(planDeps(), { id: PACK, registry: "main" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.plan?.map((p) => p.id).sort()).toEqual([DEP, DEP2, PACK].sort());
    expect(asked[0]?.plan?.at(-1)?.id).toBe(PACK);
    expect(installedIds()).toEqual([DEP, DEP2, PACK]);
    expect(kindOf(PACK)).toBe("starter-pack");
    expect(kindOf(DEP)).toBe("extension");
    expect(kindOf(DEP2)).toBe("extension");
    expect(isInstalledAsDependency(db, PACK)).toBe(false);
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(isInstalledAsDependency(db, DEP2)).toBe(true);
    const manifestBytes = readFileSync(join(dir, "extensions", PACK, "1.0.0", "manifest.json"));
    const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");
    expect(listExtensions(db).find((r) => r.id === PACK)?.entry_hash).toBe(manifestSha);
    expect(forwardDeps(db, PACK).map((d) => d.id)).toEqual([DEP, DEP2]);
    expect(existsSync(join(extensionsDir, PACK, "dist"))).toBe(false);
  });

  test("pack of packs", async () => {
    await addRemote("main", {
      [PACK]: [{ version: "1.0.0", starterPack: true, dependsOn: { [SUBPACK]: "^1.0.0" } }],
      [SUBPACK]: [{ version: "1.0.0", starterPack: true, dependsOn: { [DEP]: "^1.0.0" } }],
      [DEP]: [{ version: "1.0.0" }],
    });
    await installFromRegistry(planDeps(), { id: PACK, registry: "main" });
    expect(asked).toHaveLength(1);
    // Topological: every dependency is listed (and installed) before what needs it.
    expect(asked[0]?.plan?.map((p) => p.id)).toEqual([DEP, SUBPACK, PACK]);
    expect(installedIds()).toEqual([DEP, PACK, SUBPACK]);
    expect(kindOf(PACK)).toBe("starter-pack");
    expect(kindOf(SUBPACK)).toBe("starter-pack");
    expect(kindOf(DEP)).toBe("extension");
    expect(isInstalledAsDependency(db, PACK)).toBe(false);
    expect(isInstalledAsDependency(db, SUBPACK)).toBe(true);
    expect(isInstalledAsDependency(db, DEP)).toBe(true);
    expect(forwardDeps(db, PACK).map((d) => d.id)).toEqual([SUBPACK]);
    expect(forwardDeps(db, SUBPACK).map((d) => d.id)).toEqual([DEP]);
  });
});
