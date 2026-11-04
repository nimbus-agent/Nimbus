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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { publisherKeyFingerprint, signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { listExtensions } from "../../automation/extension-store.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { MockVault } from "../../vault/mock.ts";
import { getRunGrant, upsertRunGrant } from "../run-grant-store.ts";
import { TrustBlockError } from "../trust/trust-blocks.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import { buildTestRegistry, type TestRegistry } from "./__fixtures__/build-test-registry.ts";
import { cloneRegistrySource, sweepCloneStaging } from "./clone-source.ts";
import { installFromRegistry } from "./install-from-registry.ts";
import { insertRegistry } from "./registry-store.ts";

const ID = "com.example.tool";
const NOW = Date.parse("2026-10-18T12:00:00Z");

let db: Database;
let tmp: string;
let regDir: string;
let stagingRoot: string;
let reg: TestRegistry;

const FETCH = {
  fetchFn: () => Promise.reject(new Error("unexpected network")),
  enforceAirGap: () => false,
  now: () => NOW,
  production: false,
  builtin: null,
};

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-clone-"));
  regDir = join(tmp, "registry");
  stagingRoot = join(tmp, "data", "registry-clone-staging");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function setup(versions: string[]): Promise<void> {
  reg = await buildTestRegistry(regDir, {
    id: ID,
    versions: versions.map((version) => ({ version })),
  });
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

const clone = (req: { id: string; version?: string; registry?: string } = { id: ID }) =>
  cloneRegistrySource({ db, fetch: FETCH }, req, stagingRoot);

function staged(): string[] {
  return existsSync(stagingRoot) ? readdirSync(stagingRoot) : [];
}

describe("cloneRegistrySource", () => {
  test("clones a version whose publisher key the Vault has never seen, installing and trusting nothing", async () => {
    await setup(["1.0.0"]);
    const before = listExtensions(db);
    const out = await clone();
    expect(out).toMatchObject({
      id: ID,
      version: "1.0.0",
      channel: "stable",
      registry: "main",
      publisherId: "acme",
      keyFingerprint: publisherKeyFingerprint(reg.publisherKey),
      verifiedPublisher: null,
    });
    expect(isAbsolute(out.archivePath)).toBe(true);
    expect(out.archivePath.startsWith(stagingRoot)).toBe(true);
    const bytes = readFileSync(out.archivePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(out.packageSha256);
    expect(listExtensions(db)).toEqual(before);
    // No Vault write is structural: `CloneSourceDeps` carries no Vault, and the I44 source pin in
    // security-invariants.test.ts forbids `vault` and `publisherKeyDecision` in the clone function.
  });

  test("clones an id that is installed, leaving the row and its run grant unchanged", async () => {
    await setup(["1.0.0"]);
    await installFromRegistry(
      {
        db,
        extensionsDir: join(tmp, "extensions"),
        vault: new MockVault(),
        fetch: FETCH,
        approve: async () => true,
      },
      { id: ID },
    );
    upsertRunGrant(db, {
      extension_id: ID,
      service_id: "ext_com_example_tool",
      version: "1.0.0",
      tree_digest: "c".repeat(64),
      permissions_json: "{}",
      model_access: 0,
      approved_at: 1,
      credentials_json: "{}",
    });
    const rows = listExtensions(db);
    const grant = getRunGrant(db, ID);
    const out = await clone();
    expect(out.version).toBe("1.0.0");
    expect(listExtensions(db)).toEqual(rows);
    expect(getRunGrant(db, ID)).toEqual(grant);
  });

  test("a taken-down version is refused, and nothing is staged", async () => {
    await setup(["1.0.0"]);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: ID,
        publisherId: "acme",
        versions: ["1.0.0"],
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    const settled = await clone({ id: ID, version: "1.0.0" }).catch((e: unknown) => e);
    expect(settled).toBeInstanceOf(TrustBlockError);
    expect(String(settled)).toContain("ERR_EXTENSION_TAKEN_DOWN");
    expect(staged()).toEqual([]);
  });

  test("a tampered package is refused ERR_REGISTRY_HASH_MISMATCH, and nothing is staged", async () => {
    await setup(["1.0.0"]);
    const p = join(regDir, "extensions", ID, "1.0.0", "package.tgz");
    const bytes = readFileSync(p);
    bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0xff;
    writeFileSync(p, bytes);
    await expect(clone()).rejects.toThrow("ERR_REGISTRY_HASH_MISMATCH");
    expect(staged()).toEqual([]);
  });

  test("a manifest whose signature does not verify is refused as install refuses it, and nothing is staged", async () => {
    reg = await buildTestRegistry(regDir, {
      id: ID,
      versions: [{ version: "1.0.0" }],
      badManifestSignature: true,
    });
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
    await expect(clone()).rejects.toThrow("ERR_REGISTRY_SIGNATURE_INVALID");
    expect(staged()).toEqual([]);
  });
});

describe("cloneRegistrySource picks versions as install does (I48)", () => {
  test("an implicit clone skips a taken-down 1.1.0 for the clean 1.0.0", async () => {
    await setup(["1.0.0", "1.1.0"]);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 70);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: ID,
        publisherId: "acme",
        versions: ["1.1.0"],
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    expect((await clone()).version).toBe("1.0.0");
  });

  test("an explicit registry clones from that registry, and a registry not added is refused", async () => {
    await setup(["1.0.0"]);
    expect(await clone({ id: ID, registry: "main" })).toMatchObject({
      registry: "main",
      version: "1.0.0",
    });
    await expect(clone({ id: ID, registry: "elsewhere" })).rejects.toThrow(
      "ERR_REGISTRY_NOT_FOUND",
    );
  });
});

describe("sweepCloneStaging", () => {
  test("an old entry without the c- prefix is left alone", () => {
    mkdirSync(stagingRoot, { recursive: true });
    const other = join(stagingRoot, "keep-me");
    mkdirSync(other);
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(other, twoHoursAgo, twoHoursAgo);
    sweepCloneStaging(stagingRoot, Date.now());
    expect(readdirSync(stagingRoot)).toEqual(["keep-me"]);
  });

  test("removes an entry older than the max age and keeps a fresh one", () => {
    mkdirSync(stagingRoot, { recursive: true });
    const old = join(stagingRoot, "c-old");
    const fresh = join(stagingRoot, "c-fresh");
    mkdirSync(old);
    mkdirSync(fresh);
    writeFileSync(join(old, "package.tgz"), "x");
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 3_600_000);
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    sweepCloneStaging(stagingRoot, now);
    expect(readdirSync(stagingRoot)).toEqual(["c-fresh"]);
  });

  test("an old entry that is not a real directory is left alone", () => {
    mkdirSync(stagingRoot, { recursive: true });
    const file = join(stagingRoot, "c-file");
    writeFileSync(file, "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(file, twoHoursAgo, twoHoursAgo);
    sweepCloneStaging(stagingRoot, Date.now());
    expect(readdirSync(stagingRoot)).toEqual(["c-file"]);
  });

  test("a missing staging root is not an error", () => {
    expect(() => sweepCloneStaging(join(tmp, "absent"), Date.now())).not.toThrow();
  });
});
