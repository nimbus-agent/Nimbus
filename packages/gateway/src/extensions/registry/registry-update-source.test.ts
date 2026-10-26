import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { writePublisherKey } from "../publisher-keys.ts";
import { verifyManifestSignature } from "../verify-signature.ts";
import {
  buildTestRegistry,
  resignIndex,
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
  runIndexedSchemaMigrations(db, 76);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-regupd-"));
  vault = new MockVault();
  served.clear();
  failing = new Set();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** One registry folder carrying several extensions (the fixture builds one id per call). */
async function buildRegistry(
  name: string,
  exts: Record<string, TestVersion[]>,
  extra: Partial<Parameters<typeof buildTestRegistry>[1]> = {},
): Promise<string> {
  const dir = join(tmp, name);
  const merged: Record<string, unknown> = {};
  let index: Record<string, unknown> = {};
  for (const [id, versions] of Object.entries(exts)) {
    const built = await buildTestRegistry(dir, { id, versions, ...extra });
    rootKey = built.rootKey;
    index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as Record<string, unknown>;
    Object.assign(merged, index["extensions"] as Record<string, unknown>);
  }
  resignIndex(join(dir, "index.json"), { ...index, extensions: merged });
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
});
