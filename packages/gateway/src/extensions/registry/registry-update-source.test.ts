import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint, signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { writePublisherKey, writePublisherKeyFor } from "../publisher-keys.ts";
import { recordTrustStatements } from "../trust/trust-store.ts";
import { verifyManifestSignature } from "../verify-signature.ts";
import {
  buildMultiExtensionRegistry,
  type buildTestRegistry,
  PUBLISHER_SEED,
  type TestVersion,
} from "./__fixtures__/build-test-registry.ts";
import type { RegistryFetchDeps } from "./registry-fetch.ts";
import { deleteRegistry, insertRegistry } from "./registry-store.ts";
import {
  collectRegistryUpdates,
  type InstalledRegistryRow,
  type RegistryUpdateSourceDeps,
} from "./registry-update-source.ts";

let db: Database;
let tmp: string;
let vault: MockVault;
let rootKey: string;
/** Remote registries are served from these folders by a fake `fetchFn`: `https://<name>.test/`. */
const served = new Map<string, string>();
let failing: Set<string>;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-regupd-"));
  vault = new MockVault();
  served.clear();
  failing = new Set();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** One registry folder carrying several extensions. */
async function buildRegistry(
  name: string,
  exts: Record<string, TestVersion[]>,
  extra: Partial<Parameters<typeof buildTestRegistry>[1]> = {},
): Promise<string> {
  const dir = join(tmp, name);
  rootKey = (await buildMultiExtensionRegistry(dir, exts, extra)).rootKey;
  return dir;
}

function addRegistry(name: string, dir: string, remote: boolean): void {
  if (remote) served.set(name, dir);
  insertRegistry(db, {
    name,
    url: remote ? `https://${name}.test/` : dir,
    rootKey,
    rootFingerprint: publisherKeyFingerprint(rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
}

function fetchDeps(): RegistryFetchDeps {
  return {
    db,
    fetchFn: async (url) => {
      const u = new URL(url);
      const name = u.hostname.replace(/\.test$/, "");
      const dir = served.get(name);
      if (dir === undefined || failing.has(name)) return new Response("down", { status: 503 });
      try {
        return new Response(readFileSync(join(dir, ...u.pathname.split("/").filter(Boolean))));
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
    enforceAirGap: () => false,
    now: () => 1000,
    production: false,
  };
}

function deps(): RegistryUpdateSourceDeps {
  return {
    db,
    fetch: fetchDeps(),
    vault,
    verifyManifestSignature: (m, k) =>
      verifyManifestSignature(m as Parameters<typeof verifyManifestSignature>[0], k),
    now: () => 42,
  };
}

function row(
  id: string,
  registry: string,
  over: Partial<InstalledRegistryRow> & { channel?: "stable" | "beta" } = {},
): InstalledRegistryRow {
  const { channel, ...rest } = over;
  return {
    id,
    version: "1.0.0",
    enabled: 1,
    source: {
      registry,
      rootFingerprint: publisherKeyFingerprint(rootKey),
      channel: channel ?? "stable",
    },
    publisherId: "acme",
    manifest: {
      id,
      version: "1.0.0",
      updateChannel: "stable",
      permissions: { network: [], filesystem: { read: [], write: [] } },
    },
    ...rest,
  };
}

function ledger(method: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM egress_ledger WHERE method = ?").get(method) as {
      n: number;
    }
  ).n;
}

const signal = new AbortController().signal;
const V12: TestVersion[] = [{ version: "1.0.0" }, { version: "1.2.0" }];

describe("collectRegistryUpdates", () => {
  test("one index fetch per registry per tick regardless of extension count", async () => {
    const dir = await buildRegistry("main", { "com.a": V12, "com.b": V12, "com.c": V12 });
    addRegistry("main", dir, true);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main"), row("com.b", "main"), row("com.c", "main")],
      signal,
    );
    expect(out.errors).toEqual([]);
    expect(out.updates.map((u) => u.id).sort()).toEqual(["com.a", "com.b", "com.c"]);
    expect(ledger("registry.index")).toBe(1);
    expect(ledger("registry.manifest")).toBe(3);
    expect(ledger("registry.package")).toBe(0);
    const u = out.updates.find((x) => x.id === "com.a");
    expect(u).toMatchObject({
      fromVersion: "1.0.0",
      toVersion: "1.2.0",
      channel: "stable",
      sourceRegistry: "main",
      rootFingerprint: publisherKeyFingerprint(rootKey),
      packagePath: "extensions/com.a/1.2.0/package.tgz",
      verificationStatus: "verified",
      publisherStatus: "verified",
      detectedAt: 42,
    });
  });

  test("no manifest is fetched for an extension already on the newest version", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, true);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { version: "1.2.0" })],
      signal,
    );
    expect(out.updates).toEqual([]);
    expect(ledger("registry.manifest")).toBe(0);
  });

  test("an id also present in another registry is ignored", async () => {
    const mainDir = await buildRegistry("main", { "com.a": [{ version: "1.0.0" }] });
    const otherDir = await buildRegistry("other", { "com.a": [{ version: "9.0.0" }] });
    addRegistry("main", mainDir, false);
    addRegistry("other", otherDir, false);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates).toEqual([]);
  });

  test("a registry whose root fingerprint changed yields no update", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, true);
    const r = row("com.a", "main");
    r.source.rootFingerprint = "0".repeat(32);
    const out = await collectRegistryUpdates(deps(), [r], signal);
    expect(out.updates).toEqual([]);
    expect(ledger("registry.index")).toBe(0);
  });

  test("removed registry yields no update", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, true);
    deleteRegistry(db, "main");
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out).toMatchObject({ updates: [], errors: [] });
    expect(ledger("registry.index")).toBe(0);
  });

  test("stable install ignores beta, beta install sees stable ∪ beta", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [{ version: "1.0.0" }, { version: "1.1.0" }, { version: "2.0.0", channel: "beta" }],
    });
    addRegistry("main", dir, false);
    const stable = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(stable.updates.map((u) => u.toVersion)).toEqual(["1.1.0"]);
    const beta = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { channel: "beta" })],
      signal,
    );
    expect(beta.updates.map((u) => [u.toVersion, u.channel])).toEqual([["2.0.0", "beta"]]);
  });

  test("publisher key change in the index surfaces as publisher_key_conflict", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, false);
    // The Vault trusts a DIFFERENT key for publisher "acme" than the one the index now names.
    const other = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 7));
    await writePublisherKey(vault, "acme", other.publicKey);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0]).toMatchObject({
      verificationStatus: "publisher_key_conflict",
      publisherStatus: "unverified",
    });
  });

  test("a key the publisher rotated to from the trusted key is verified, and the change is reported", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, false);
    const oldSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const oldKey = Buffer.from(nacl.sign.keyPair.fromSeed(oldSeed).publicKey).toString("base64");
    const newKey = Buffer.from(nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey).toString(
      "base64",
    );
    await writePublisherKey(vault, "acme", Buffer.from(oldKey, "base64"));
    const rotation = await signTrustStatement(
      {
        kind: "key.rotate",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: oldKey,
        publisherId: "acme",
        fromKey: oldKey,
        toKey: newKey,
      },
      oldSeed,
    );
    recordTrustStatements(db, [rotation], { kind: "feed", nimbusRootKey: oldKey }, 1);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates[0]).toMatchObject({
      verificationStatus: "verified",
      publisherKeyFingerprint: publisherKeyFingerprint(newKey),
      publisherKeyChange: {
        from: [publisherKeyFingerprint(oldKey)],
        to: publisherKeyFingerprint(newKey),
      },
    });
  });

  test("an update continues from ITS OWN recorded key, never a key only a sibling uses", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, false);
    // The Vault trusts the index's key (a sibling installed with it) AND this row's own key X.
    const siblingKey = nacl.sign.keyPair.fromSeed(PUBLISHER_SEED).publicKey;
    const own = nacl.sign.keyPair.fromSeed(
      Uint8Array.from({ length: 32 }, (_, i) => i + 9),
    ).publicKey;
    await writePublisherKeyFor(vault, "acme", siblingKey);
    const ownFp = await writePublisherKeyFor(vault, "acme", own);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { keyFingerprint: ownFp })],
      signal,
    );
    expect(out.updates[0]?.verificationStatus).toBe("publisher_key_conflict");
    // Without a recorded key (a legacy row), every trusted key counts, as before.
    const legacy = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(legacy.updates[0]?.verificationStatus).toBe("verified");
  });

  test("a publisher id other than the installed one is a publisher_key_conflict", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { publisherId: "someone-else" })],
      signal,
    );
    expect(out.updates[0]?.verificationStatus).toBe("publisher_key_conflict");
  });

  test("a manifest whose signature does not verify is listed as signature_failed", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 }, { badManifestSignature: true });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates[0]).toMatchObject({
      verificationStatus: "signature_failed",
      publisherStatus: "unverified",
    });
  });

  test("one failing registry does not block another in the same tick", async () => {
    const downDir = await buildRegistry("down", { "com.a": V12 });
    const upDir = await buildRegistry("up", { "com.b": V12 });
    addRegistry("down", downDir, true);
    addRegistry("up", upDir, true);
    failing.add("down");
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "down"), row("com.b", "up")],
      signal,
    );
    expect(out.updates.map((u) => u.id)).toEqual(["com.b"]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]?.registry).toBe("down");
    expect(out.errors[0]?.error).toContain("ERR_REGISTRY_UNREACHABLE");
  });

  test("a remote registry is refused under air-gap while a local one still answers", async () => {
    const remoteDir = await buildRegistry("remote", { "com.a": V12 });
    const localDir = await buildRegistry("local", { "com.b": V12 });
    addRegistry("remote", remoteDir, true);
    addRegistry("local", localDir, false);
    const d = deps();
    d.fetch = { ...d.fetch, enforceAirGap: () => true };
    const out = await collectRegistryUpdates(
      d,
      [row("com.a", "remote"), row("com.b", "local")],
      signal,
    );
    expect(out.updates.map((u) => u.id)).toEqual(["com.b"]);
    expect(out.errors[0]?.error).toContain("ERR_REGISTRY_AIR_GAP");
    expect(ledger("registry.index")).toBe(0);
  });

  test("a disabled extension is not polled", async () => {
    const dir = await buildRegistry("main", { "com.a": V12 });
    addRegistry("main", dir, true);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { enabled: 0 })],
      signal,
    );
    expect(out.updates).toEqual([]);
    expect(ledger("registry.index")).toBe(0);
  });

  test("the new version's dependsOn is reported for the conflict check", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [{ version: "1.0.0" }, { version: "1.2.0", dependsOn: { "com.dep": "^1.0.0" } }],
    });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.dependsOn.get("com.a")).toEqual({ "com.dep": "^1.0.0" });
  });

  test("an update to a starter pack is not offered, and the error carries the reason", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [
        { version: "1.0.0" },
        { version: "1.2.0", starterPack: true, dependsOn: { "com.dep": "^1.0.0" } },
      ],
    });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates).toEqual([]);
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0]).toMatchObject({ id: "com.a", registry: "main" });
    expect(out.refused[0]?.error).toContain("ERR_EXTENSION_MANIFEST_UNSUPPORTED");
    expect(out.refused[0]?.error).toContain("com.a is a starter pack");
  });

  test("a refused update is not a registry error, so the registry's stale offers can still be dropped", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [
        { version: "1.0.0" },
        { version: "1.2.0", starterPack: true, dependsOn: { "com.dep": "^1.0.0" } },
      ],
      "com.b": V12,
    });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main"), row("com.b", "main")],
      signal,
    );
    // `errors` marks a registry as transiently failing, which keeps every cached offer from it.
    expect(out.errors).toEqual([]);
    expect(out.refused.map((r) => r.id)).toEqual(["com.a"]);
    expect(out.updates.map((u) => u.id)).toEqual(["com.b"]);
  });

  test("an update adding a cross-registry dependency is offered, with the dependency's range in dependsOn", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [
        { version: "1.0.0" },
        {
          version: "1.2.0",
          dependsOn: { "com.dep": { range: "^1.0.0", registry: "nimbus-official" } },
        },
      ],
    });
    addRegistry("main", dir, false);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates.map((u) => u.toVersion)).toEqual(["1.2.0"]);
    expect(out.errors).toEqual([]);
    expect(out.refused).toEqual([]);
    expect(out.dependsOn.get("com.a")).toEqual({ "com.dep": "^1.0.0" });
  });
});

describe("collectRegistryUpdates never offers a blocked version (I48)", () => {
  const NIMBUS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i + 80);
  const NIMBUS_KEY = Buffer.from(nacl.sign.keyPair.fromSeed(NIMBUS_SEED).publicKey).toString(
    "base64",
  );
  async function takedown(id: string, versions: string[]): Promise<void> {
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: NIMBUS_KEY,
        extensionId: id,
        publisherId: "acme",
        versions,
        reason: "malware",
      },
      NIMBUS_SEED,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: NIMBUS_KEY }, 1);
  }

  test("a taken-down newest version is skipped for the clean one below it", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [{ version: "1.0.0" }, { version: "1.0.9" }, { version: "1.1.0" }],
    });
    addRegistry("main", dir, true);
    await takedown("com.a", ["1.1.0"]);
    const out = await collectRegistryUpdates(deps(), [row("com.a", "main")], signal);
    expect(out.updates.map((u) => u.toVersion)).toEqual(["1.0.9"]);
  });

  test("an installed taken-down version is offered the clean NEWER one, never a downgrade", async () => {
    const dir = await buildRegistry("main", {
      "com.a": [{ version: "1.0.9" }, { version: "1.1.0" }, { version: "1.1.1" }],
    });
    addRegistry("main", dir, true);
    await takedown("com.a", ["1.1.0"]);
    const onTakenDown = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { version: "1.1.0" })],
      signal,
    );
    expect(onTakenDown.updates.map((u) => u.toVersion)).toEqual(["1.1.1"]);
    await takedown("com.a", ["1.1.1"]);
    const nothingNewer = await collectRegistryUpdates(
      deps(),
      [row("com.a", "main", { version: "1.1.0" })],
      signal,
    );
    expect(nothingNewer.updates).toEqual([]);
    expect(ledger("registry.manifest")).toBe(1);
  });
});
