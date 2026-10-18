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
import * as tar from "tar";
import nacl from "tweetnacl";

import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import {
  type ExtensionInstallApprovalRequest,
  publisherKeyFingerprint,
} from "../install-from-local.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import {
  buildTestRegistry,
  PUBLISHER_SEED,
  resignIndex,
  type TestRegistry,
} from "./__fixtures__/build-test-registry.ts";
import { type InstallFromRegistryDeps, installFromRegistry } from "./install-from-registry.ts";
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
  runIndexedSchemaMigrations(db, 71);
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
    expect(out.publisher.id).toBe("acme");
    expect(listExtensions(db).map((r) => r.id)).toEqual([ID]);
  });
});
