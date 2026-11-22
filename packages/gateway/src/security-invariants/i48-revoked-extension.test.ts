import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, SRC_ROOT } from "../../test/helpers/security-invariants.ts";
import { buildTestRegistry } from "../extensions/registry/__fixtures__/build-test-registry.ts";
import { LocalIndex } from "../index/local-index.ts";
import { encodeBase64 } from "../util/base64.ts";
import { generateEd25519Keypair } from "../util/ed25519.ts";

describe("I48 — revoked or taken-down extension code is never installed, updated or spawned without an acknowledging approval", () => {
  // Real statements signed by a test Nimbus trust root and stored through the real store; a real
  // install, approval and spawn verification; a real local-folder registry. Nothing spawns.
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 48);
  const roots: string[] = [];
  const dbs: Database[] = [];
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  async function nimbusKey(): Promise<string> {
    const nacl = (await import("tweetnacl")).default;
    return encodeBase64(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey);
  }

  /** Stores one Nimbus-signed statement through the real store; returns its id. */
  async function block(
    db: Database,
    s:
      | { kind: "key.revoke"; publisherId: string; keyFingerprint: string; reason: string }
      | {
          kind: "extension.takedown";
          extensionId: string;
          publisherId: string;
          versions: "*" | string[];
          reason: string;
        },
  ): Promise<string> {
    const { signTrustStatement, trustStatementId } = await import("@nimbus-dev/registry-format");
    const { recordTrustStatements } = await import("../extensions/trust/trust-store.ts");
    const key = await nimbusKey();
    const signed = await signTrustStatement(
      { ...s, issuedAt: "2026-10-26T12:00:00Z", signerKey: key },
      NIMBUS_SEED,
    );
    expect(
      recordTrustStatements(db, [signed], { kind: "feed", nimbusRootKey: key }, 1).inserted,
    ).toBe(1);
    return trustStatementId(signed);
  }

  /** A signed extension, installed and approved through the production functions. */
  async function installedSigned() {
    const { installExtensionFromLocalDirectory } = await import(
      "../extensions/install-from-local.ts"
    );
    const { signManifest } = await import("../extensions/verify-signature.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "nimbus-i48-")));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    mkdirSync(join(root, "data"), { recursive: true });
    const env = {
      platform: process.platform,
      protectedRoots: [join(root, "data")],
      runtimeReadPaths: [],
      realpath: (p: string) => realpathSync.native(p),
    };
    const kp = generateEd25519Keypair();
    const manifest: Record<string, unknown> = {
      id: "com.example.i48",
      version: "1.0.0",
      entry: "dist/index.js",
      permissions: {},
      publisher: { id: "i48-pub", key: encodeBase64(kp.pubkey) },
    };
    manifest["signature"] = await signManifest(manifest, kp.privkey);
    const src = join(root, "src");
    mkdirSync(join(src, "dist"), { recursive: true });
    writeFileSync(join(src, "nimbus.extension.json"), JSON.stringify(manifest));
    writeFileSync(join(src, "dist", "index.js"), "export {};\n");
    const vault = new MockVault();
    await installExtensionFromLocalDirectory({
      db,
      extensionsDir: join(root, "data", "extensions"),
      sourcePath: src,
      vault,
      publisherKey: kp.pubkey,
      approve: async () => true,
    });
    const asked: Array<Record<string, unknown>> = [];
    const approve = async () => {
      const { approveExtensionRun } = await import("../extensions/approve-run.ts");
      return approveExtensionRun("com.example.i48", {
        db,
        env,
        gate: async (a) => {
          asked.push(a.payload);
          return true;
        },
        runtimeEnabled: true,
        now: () => 1,
      });
    };
    const spawn = async () => {
      const { readVerifiedExtensionForSpawn } = await import("../extensions/verified-extension.ts");
      return readVerifiedExtensionForSpawn("com.example.i48", { db, vault, env });
    };
    return {
      db,
      asked,
      approve,
      spawn,
      fingerprint: publisherKeyFingerprint(encodeBase64(kp.pubkey)),
    };
  }

  test("a revoked key refuses the spawn; the approval that shows and acknowledges it resumes it; a NEW block refuses again", async () => {
    const x = await installedSigned();
    await x.approve();
    expect((await x.spawn()).extensionId).toBe("com.example.i48");
    const revoked = await block(x.db, {
      kind: "key.revoke",
      publisherId: "i48-pub",
      keyFingerprint: x.fingerprint,
      reason: "leaked",
    });
    await expect(x.spawn()).rejects.toThrow("ERR_EXTENSION_KEY_REVOKED");
    // Re-approval is the override: the prompt names the block, the grant records its id.
    expect((await x.approve()).changed).toBe(true);
    const shown = x.asked.at(-1)?.["trustBlocks"] as Array<{ statementId: string }>;
    expect(shown.map((b) => b.statementId)).toEqual([revoked]);
    expect((await x.spawn()).extensionId).toBe("com.example.i48");
    // A later block was never acknowledged.
    await block(x.db, {
      kind: "extension.takedown",
      extensionId: "com.example.i48",
      publisherId: "i48-pub",
      versions: "*",
      reason: "malware",
    });
    await expect(x.spawn()).rejects.toThrow("ERR_EXTENSION_TAKEN_DOWN");
  });

  test("a registry install of a taken-down version is refused before the owner is asked; the default pick skips it", async () => {
    const { installFromRegistry } = await import("../extensions/registry/install-from-registry.ts");
    const { insertRegistry } = await import("../extensions/registry/registry-store.ts");
    const { MockVault } = await import("../vault/mock.ts");
    const root = mkdtempSync(join(tmpdir(), "nimbus-i48-reg-"));
    roots.push(root);
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    const dir = join(root, "registry");
    const built = await buildTestRegistry(dir, {
      id: "com.example.i48r",
      versions: [{ version: "1.0.0" }, { version: "1.1.0" }],
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
    await block(db, {
      kind: "extension.takedown",
      extensionId: "com.example.i48r",
      publisherId: "acme",
      versions: ["1.1.0"],
      reason: "malware",
    });
    let asked = 0;
    const deps = {
      db,
      extensionsDir: join(root, "extensions"),
      vault: new MockVault(),
      fetch: {
        fetchFn: () => Promise.reject(new Error("no network in the I48 tests")),
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
    await expect(
      installFromRegistry(deps, { id: "com.example.i48r", version: "1.1.0" }),
    ).rejects.toThrow("ERR_EXTENSION_TAKEN_DOWN");
    expect(asked).toBe(0);
    expect((await installFromRegistry(deps, { id: "com.example.i48r" })).version).toBe("1.0.0");
  });

  test("stored blocks are a monotonic union: no later verification set, feed or store call removes one", async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    LocalIndex.ensureSchema(db);
    await block(db, {
      kind: "key.revoke",
      publisherId: "acme",
      keyFingerprint: "0".repeat(32),
      reason: "leaked",
    });
    const { replaceCurrentVerifications, trustStoreCounts } = await import(
      "../extensions/trust/trust-store.ts"
    );
    replaceCurrentVerifications(db, [], await nimbusKey(), 2);
    expect(trustStoreCounts(db).revocations).toBe(1);
    // The store's only DELETE removes the CURRENT verifications (spec R7), never a block.
    // On the source WITH its string literals: the SQL lives in them.
    const raw = stripComments(await read("packages/gateway/src/extensions/trust/trust-store.ts"));
    expect(raw).not.toMatch(/\bUPDATE\s+(?:OR\s+\w+\s+)?trust_statement\b/i);
    expect(raw).not.toMatch(/\bINSERT\s+OR\s+REPLACE\s+INTO\s+trust_statement\b/i);
    expect(raw.match(/DELETE FROM trust_statement[^"`]*/g)).toEqual([
      "DELETE FROM trust_statement WHERE kind = 'publisher.verified' AND source IN ('feed', 'snapshot')",
    ]);
  });

  test("source pins: every door checks BEFORE it acts", async () => {
    const spawn = stripComments(
      await read("packages/gateway/src/extensions/verified-extension.ts"),
    );
    const verify = spawn.slice(
      spawn.indexOf("export async function readVerifiedExtensionForSpawn("),
    );
    const blockedAt = verify.indexOf("assertNotBlocked(deps.db, row, manifest, grant);");
    expect(blockedAt).toBeGreaterThan(-1);
    expect(blockedAt).toBeLessThan(verify.indexOf("assertTreeAndVersion("));
    const sig = spawn.slice(spawn.indexOf("async function assertPublisherSignature("));
    const revokedAt = sig.indexOf("assertKeyNotRevoked(db, row, manifest, grant, key);");
    expect(revokedAt).toBeGreaterThan(-1);
    expect(revokedAt).toBeLessThan(sig.indexOf("await verifyManifestSignature(raw, key);"));

    const reg = stripComments(
      await read("packages/gateway/src/extensions/registry/install-from-registry.ts"),
    );
    // The install and the author's clone share one verified chain (`fetchVerifiedPackageBytes`),
    // and the install reaches its manifest only through it.
    // Each body bounded at the next top-level export, so a later function cannot satisfy it.
    const bodyOf = (code: string, header: string): string => {
      const at = code.indexOf(header);
      expect(at, header).toBeGreaterThan(-1);
      const next = code.indexOf("\nexport ", at + 1);
      return code.slice(at, next === -1 ? undefined : next);
    };
    const fetchFn = bodyOf(reg, "export async function fetchVerifiedPackageBytes(");
    const installFn = bodyOf(reg, "export async function fetchVerifiedRegistryPackage(");
    expect(fetchFn.indexOf("assertNotBlocked(db, subjectAt(version));")).toBeGreaterThan(-1);
    expect(fetchFn.indexOf("assertNotBlocked(db, subjectAt(version));")).toBeLessThan(
      fetchFn.indexOf("await fetchRegistryManifest("),
    );
    expect(installFn).toMatch(/await fetchVerifiedPackageBytes\(fetchDeps, deps\.db, req\)/);

    const local = stripComments(
      await read("packages/gateway/src/extensions/install-from-local.ts"),
    );
    const main = local.slice(
      local.indexOf("export async function installExtensionFromLocalDirectory("),
    );
    expect(main.indexOf("assertNotBlocked(options.db,")).toBeGreaterThan(-1);
    expect(main.indexOf("assertNotBlocked(options.db,")).toBeLessThan(
      main.indexOf("await requireInstallApproval("),
    );

    const apply = stripComments(await read("packages/gateway/src/extensions/auto-update-init.ts"));
    const reverify = apply.slice(apply.indexOf("async function reverifyUpdateManifest("));
    expect(reverify.slice(0, reverify.indexOf("\n}\n"))).toContain(
      "assertNotBlocked(fetchDeps.db,",
    );

    const detect = stripComments(
      await read("packages/gateway/src/extensions/registry/registry-update-source.ts"),
    );
    expect(detect).toMatch(
      /\.filter\(\(\[v, e\]\) => wanted\.includes\(e\.channel\) && !isBlocked\(v\)\)/,
    );
  });
});

describe("I48 — a publisher statement from a registry counts only for that registry's extensions (trust layer PR 3b)", () => {
  // The hostile-registry attack: a third-party registry lists a victim's publisher id under its own
  // key S and carries `rotate S -> victim key` plus `revoke S`, both self-signed by S. Through the real
  // store and the real block evaluator, that must not block the victim's code installed from another
  // registry, while the same statements in the Nimbus feed still apply everywhere.
  test("a planted rotation + revocation blocks nothing outside the registry that carried it", async () => {
    const nacl = (await import("tweetnacl")).default;
    const { publisherKeyFingerprint, signTrustStatement } = await import(
      "@nimbus-dev/registry-format"
    );
    const { recordTrustStatements } = await import("../extensions/trust/trust-store.ts");
    const { blocksFor } = await import("../extensions/trust/trust-blocks.ts");
    const pair = (n: number) => {
      const seed = new Uint8Array(32).fill(n);
      const key = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
      return { seed, key, fp: publisherKeyFingerprint(key) };
    };
    const attacker = pair(201);
    const victim = pair(202);
    const root = pair(203);
    const nimbus = pair(204);
    const issuedAt = "2026-10-27T12:00:00Z";
    const rotation = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt,
        signerKey: attacker.key,
        publisherId: "victim",
        fromKey: attacker.key,
        toKey: victim.key,
      },
      attacker.seed,
    );
    const revocation = await signTrustStatement(
      {
        kind: "key.revoke",
        issuedAt,
        signerKey: attacker.key,
        publisherId: "victim",
        keyFingerprint: attacker.fp,
        reason: "planted",
      },
      attacker.seed,
    );
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      recordTrustStatements(
        db,
        [rotation, revocation],
        {
          kind: "registry",
          name: "hostile",
          rootKey: root.key,
          rootFingerprint: root.fp,
          listedPublisherKeys: new Map([["victim", new Set([attacker.key, victim.key])]]),
        },
        1,
      );
      const subject = (source: { registry: string; rootFingerprint: string } | null) => ({
        extensionId: "victim/tool",
        version: "1.0.0",
        publisherId: "victim",
        keyFingerprint: victim.fp,
        source,
      });
      expect(
        blocksFor(db, subject({ registry: "trusted", rootFingerprint: "a".repeat(32) })),
      ).toEqual([]);
      expect(blocksFor(db, subject(null))).toEqual([]);
      expect(
        blocksFor(db, subject({ registry: "hostile", rootFingerprint: root.fp })),
      ).toHaveLength(1);
      recordTrustStatements(
        db,
        [rotation, revocation],
        { kind: "feed", nimbusRootKey: nimbus.key },
        2,
      );
      expect(
        blocksFor(db, subject({ registry: "trusted", rootFingerprint: "a".repeat(32) })),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("source pin: publisher rows and rotation edges go through publisherStatementInScope", () => {
    const src = readFileSync(join(SRC_ROOT, "extensions", "trust", "trust-blocks.ts"), "utf8");
    expect(src).toContain(
      'if (row.signerRole === "publisher") return publisherStatementInScope(row.sources, s.source);',
    );
    expect(src).toContain("ancestorsOf(rotationEdgesFor(db, s.publisherId, s.source), fp)");
    const keys = readFileSync(join(SRC_ROOT, "extensions", "trust", "trust-keys.ts"), "utf8");
    expect(keys).toContain("rotationEdgesFor(db, ctx.publisherId, ctx.source)");
    expect(keys).not.toContain("readRotationEdges");
  });
});
