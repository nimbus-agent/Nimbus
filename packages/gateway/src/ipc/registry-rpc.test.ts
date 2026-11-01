import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseRegistryIndex,
  publisherKeyFingerprint,
  type RegistryIndex,
  registryIndexDigest,
  registryIndexSigningBytes,
  signTrustStatement,
} from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";
import { isInstalledAsDependency } from "../automation/extension-store.ts";
import {
  buildMultiExtensionRegistry,
  buildTestRegistry,
} from "../extensions/registry/__fixtures__/build-test-registry.ts";
import { getRegistry, insertRegistry } from "../extensions/registry/registry-store.ts";
import {
  recordTrustStatements,
  replaceCurrentVerifications,
} from "../extensions/trust/trust-store.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { encodeBase64 } from "../util/base64.ts";
import { MockVault } from "../vault/mock.ts";
import { setGatewayEventBroadcast } from "./gateway-events.ts";
import {
  dispatchRegistryRpc,
  type RegistryFetchBag,
  type RegistryOwnerGate,
} from "./registry-rpc.ts";

const KEYPAIR = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const ROOT_KEY = encodeBase64(KEYPAIR.publicKey);
const FINGERPRINT = publisherKeyFingerprint(ROOT_KEY);
const NOW = Date.parse("2026-10-18T12:00:00Z");

function signedIndex(sequence: number, generatedAt = "2026-10-18T12:00:00Z"): RegistryIndex {
  const base = {
    format: 1 as const,
    rootKey: ROOT_KEY,
    sequence,
    generatedAt,
    extensions: {},
  };
  const sig = nacl.sign.detached(registryIndexSigningBytes(base), KEYPAIR.secretKey);
  return { ...base, signature: encodeBase64(sig) };
}

let db: Database;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 77);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-registry-rpc-"));
  writeFileSync(join(tmp, "index.json"), JSON.stringify(signedIndex(3)));
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

const fetchBag = (over: Partial<RegistryFetchBag> = {}): RegistryFetchBag => ({
  fetchFn: () => Promise.reject(new Error("unexpected network")),
  enforceAirGap: () => false,
  now: () => NOW,
  production: false,
  // Neutral test default: never reach the real official registry host.
  builtin: null,
  ...over,
});

function gateRecorder(answer: boolean): { gate: RegistryOwnerGate; asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    gate: async (a) => {
      asked.push(a);
      return answer;
    },
  };
}

function ledgerCount(): number {
  return (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
}

function call(
  method: string,
  params: unknown,
  o: { gate?: RegistryOwnerGate; fetch?: RegistryFetchBag } = {},
) {
  return dispatchRegistryRpc({
    method,
    params,
    db,
    fetch: o.fetch ?? fetchBag(),
    ...(o.gate === undefined ? {} : { ownerGate: o.gate }),
  });
}

describe("registry.add", () => {
  test("pins the key after approval", async () => {
    const g = gateRecorder(true);
    const out = await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    expect(out).toEqual({
      kind: "hit",
      value: {
        name: "main",
        url: tmp,
        rootFingerprint: FINGERPRINT,
        extensionCount: 0,
        generatedAt: "2026-10-18T12:00:00Z",
      },
    });
    expect(g.asked).toEqual([
      {
        type: "registry.add",
        payload: {
          name: "main",
          url: tmp,
          rootFingerprint: FINGERPRINT,
          extensionCount: 0,
          generatedAt: "2026-10-18T12:00:00Z",
        },
      },
    ]);
    const row = getRegistry(db, "main");
    expect(row?.rootKey).toBe(ROOT_KEY);
    expect(row?.lastSequence).toBe(3);
    // The add records the document it showed the owner, so a later fetch at sequence 3 must be it.
    const served = parseRegistryIndex(readFileSync(join(tmp, "index.json")));
    expect(row?.lastIndexSha256).toBe(registryIndexDigest(served));
  });

  test("a denial stores nothing and reports ERR_REGISTRY_ADD_NOT_APPROVED", async () => {
    const g = gateRecorder(false);
    await expect(
      call("registry.add", { name: "main", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_ADD_NOT_APPROVED");
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("records the index fetch even when denied (remote), but stores no registry row", async () => {
    const g = gateRecorder(false);
    const fetchFn = () => Promise.resolve(new Response(JSON.stringify(signedIndex(1))));
    await expect(
      call(
        "registry.add",
        { name: "main", url: "https://reg.example/r" },
        { gate: g.gate, fetch: fetchBag({ fetchFn }) },
      ),
    ).rejects.toThrow("ERR_REGISTRY_ADD_NOT_APPROVED");
    expect(ledgerCount()).toBe(1);
    expect(
      (db.query("SELECT source_type FROM egress_ledger").get() as { source_type: string })
        .source_type,
    ).toBe("registry");
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("a wrong --fingerprint refuses before prompting", async () => {
    const g = gateRecorder(true);
    await expect(
      call(
        "registry.add",
        { name: "main", url: tmp, fingerprint: "0".repeat(32) },
        { gate: g.gate },
      ),
    ).rejects.toThrow("ERR_REGISTRY_FINGERPRINT_MISMATCH");
    expect(g.asked).toEqual([]);
    expect(getRegistry(db, "main")).toBeUndefined();
  });

  test("a matching fingerprint is trimmed and lowercased, then prompts", async () => {
    const g = gateRecorder(true);
    await call(
      "registry.add",
      { name: "main", url: tmp, fingerprint: `  ${FINGERPRINT.toUpperCase()} ` },
      { gate: g.gate },
    );
    expect(g.asked).toHaveLength(1);
  });

  test("a malformed fingerprint is refused with the expected shape, before any fetch", async () => {
    const g = gateRecorder(true);
    await expect(
      call("registry.add", { name: "main", url: tmp, fingerprint: "abc" }, { gate: g.gate }),
    ).rejects.toThrow("must be 32 hex characters");
    expect(g.asked).toEqual([]);
  });

  test("refuses an existing name and an existing url", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    await expect(
      call("registry.add", { name: "main", url: "/other" }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_EXISTS");
    await expect(
      call("registry.add", { name: "second", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_EXISTS");
    expect(g.asked).toHaveLength(1);
  });

  test("refuses without an owner gate and for an invalid name", async () => {
    await expect(call("registry.add", { name: "main", url: tmp })).rejects.toThrow(
      "requires the owner's HITL gate",
    );
    const g = gateRecorder(true);
    await expect(
      call("registry.add", { name: "Bad Name", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_INVALID_PARAMS");
  });
});

describe("registry.list", () => {
  test("reads the database only and marks an index older than 30 days stale", async () => {
    for (const [name, generatedAt] of [
      ["fresh", "2026-10-10T00:00:00Z"],
      ["old", "2026-08-01T00:00:00Z"],
    ] as const) {
      insertRegistry(db, {
        name,
        url: `/r/${name}`,
        rootKey: ROOT_KEY,
        rootFingerprint: FINGERPRINT,
        lastSequence: 1,
        lastGeneratedAt: generatedAt,
        addedAt: 1,
        lastIndexSha256: null,
      });
    }
    const out = await call("registry.list", {});
    const value = (out as { value: { registries: Array<Record<string, unknown>> } }).value;
    expect(value.registries.map((r) => [r["name"], r["stale"], r["extensionCount"]])).toEqual([
      ["fresh", false, null],
      ["old", true, null],
    ]);
    expect(ledgerCount()).toBe(0);
  });
});

describe("registry.refresh", () => {
  test("reports per-registry results, a failure does not stop the rest", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    insertRegistry(db, {
      name: "gone",
      url: join(tmp, "missing"),
      rootKey: ROOT_KEY,
      rootFingerprint: FINGERPRINT,
      lastSequence: 1,
      lastGeneratedAt: "2026-10-01T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const out = (await call("registry.refresh", {})) as {
      value: {
        results: Array<{
          name: string;
          ok: boolean;
          error?: string;
          sequence?: number;
          extensionCount?: number;
        }>;
      };
    };
    const byName = Object.fromEntries(out.value.results.map((r) => [r.name, r]));
    expect(byName["main"]).toEqual({ name: "main", ok: true, sequence: 3, extensionCount: 0 });
    expect(byName["gone"]?.ok).toBe(false);
    expect(byName["gone"]?.error).toContain("ERR_REGISTRY_");
  });

  test("an unknown name is ERR_REGISTRY_NOT_FOUND", async () => {
    await expect(call("registry.refresh", { name: "nope" })).rejects.toThrow(
      "ERR_REGISTRY_NOT_FOUND",
    );
  });
});

describe("registry.remove", () => {
  test("returns the ids of extensions installed from it", async () => {
    const g = gateRecorder(true);
    await call("registry.add", { name: "main", url: tmp }, { gate: g.gate });
    db.run(
      "INSERT INTO extension (id, version, install_path, manifest_hash, entry_hash, enabled, installed_at, last_verified_at, source_registry, source_root_fingerprint, source_channel) VALUES ('acme.tool', '1.0.0', '/x', 'h', 'e', 1, 1, 1, 'main', ?, 'stable')",
      [FINGERPRINT],
    );
    const out = await call("registry.remove", { name: "main" });
    expect(out).toEqual({
      kind: "hit",
      value: { removed: true, orphanedExtensions: ["acme.tool"] },
    });
    expect(getRegistry(db, "main")).toBeUndefined();
    expect(await call("registry.remove", { name: "main" })).toEqual({
      kind: "hit",
      value: { removed: false, orphanedExtensions: [] },
    });
  });
});

test("an unknown registry method is a miss", async () => {
  expect(await call("registry.nope", {})).toEqual({ kind: "miss" });
});

type FixtureVersion = {
  version: string;
  channel: "stable" | "beta";
  name: string;
  manifestOverride?: string;
  /** The manifest's `repository` (provenance). */
  repository?: string;
  /** The manifest's declared `filesystem` permissions. */
  filesystem?: { read: string[]; write: string[] };
  /** The version entry's `provenance`, as a registry's sign job records it. */
  provenance?: unknown;
  /** The version entry's raw `quality`, as a registry's sign job records it. */
  quality?: unknown;
};

/** A local registry directory with a root-signed index and one manifest per version. */
function makeRegistry(
  dir: string,
  extensions: Record<string, { publisherId: string; versions: FixtureVersion[] }>,
  sequence = 3,
  extra: Record<string, unknown> = {},
): void {
  const entries: RegistryIndex["extensions"] = {};
  const built: Record<string, unknown> = {};
  for (const [id, ext] of Object.entries(extensions)) {
    const versions: Record<string, unknown> = {};
    for (const v of ext.versions) {
      const base = `extensions/${id}/${v.version}`;
      const manifest = JSON.stringify({
        id,
        name: v.name,
        version: v.version,
        entry: "dist/index.js",
        permissions: {
          network: ["api.example.com"],
          ...(v.filesystem !== undefined && { filesystem: v.filesystem }),
        },
        ...(v.repository !== undefined && { repository: v.repository }),
      });
      mkdirSync(join(dir, base), { recursive: true });
      writeFileSync(join(dir, base, "manifest.json"), v.manifestOverride ?? manifest);
      versions[v.version] = {
        channel: v.channel,
        name: v.name,
        manifest: `${base}/manifest.json`,
        manifestSha256: createHash("sha256").update(manifest).digest("hex"),
        package: `${base}/package.tgz`,
        packageSha256: "a".repeat(64),
        packageSizeBytes: 1234,
        entryHash: "b".repeat(64),
        publishedAt: "2026-10-01T00:00:00Z",
        ...(v.provenance !== undefined && { provenance: v.provenance }),
        ...(v.quality !== undefined && { quality: v.quality }),
      };
    }
    built[id] = { publisher: { id: ext.publisherId, key: ROOT_KEY }, versions };
  }
  Object.assign(entries, built);
  const base = {
    format: 1 as const,
    rootKey: ROOT_KEY,
    sequence,
    generatedAt: "2026-10-18T12:00:00Z",
    extensions: entries,
    ...extra,
  };
  const sig = nacl.sign.detached(registryIndexSigningBytes(base), KEYPAIR.secretKey);
  writeFileSync(join(dir, "index.json"), JSON.stringify({ ...base, signature: encodeBase64(sig) }));
}

function pin(name: string, url: string): void {
  insertRegistry(db, {
    name,
    url,
    rootKey: ROOT_KEY,
    rootFingerprint: FINGERPRINT,
    lastSequence: 1,
    lastGeneratedAt: "2026-10-18T12:00:00Z",
    addedAt: 1,
    lastIndexSha256: null,
  });
}

describe("registry.search and registry.info", () => {
  let other: string;
  beforeEach(() => {
    other = mkdtempSync(join(tmpdir(), "nimbus-registry-rpc-b-"));
  });
  afterEach(() => rmSync(other, { recursive: true, force: true }));

  test("search matches name case-insensitively across two registries and tags results", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          { version: "1.0.0", channel: "stable", name: "Old Name" },
          { version: "1.1.0", channel: "stable", name: "Widget Tool" },
          { version: "1.2.0-beta.1", channel: "beta", name: "Widget Tool" },
        ],
      },
    });
    makeRegistry(other, {
      "other.widget": {
        publisherId: "other",
        versions: [{ version: "2.0.0", channel: "stable", name: "Another" }],
      },
      "x.unrelated": {
        publisherId: "x",
        versions: [{ version: "1.0.0", channel: "stable", name: "Nope" }],
      },
    });
    pin("main", tmp);
    pin("second", other);
    const out = (await call("registry.search", { query: "WIDGET" })) as {
      value: { results: unknown[]; errors: unknown[] };
    };
    expect(out.value.errors).toEqual([]);
    expect(out.value.results).toEqual([
      {
        registry: "main",
        id: "acme.tool",
        name: "Widget Tool",
        publisherId: "acme",
        latestStable: "1.1.0",
        latestBeta: "1.2.0-beta.1",
        blocked: false,
        verifiedPublisher: null,
        quality: null,
      },
      {
        registry: "second",
        id: "other.widget",
        name: "Another",
        publisherId: "other",
        latestStable: "2.0.0",
        latestBeta: null,
        blocked: false,
        verifiedPublisher: null,
        quality: null,
      },
    ]);
  });

  test("search and info report the verified publisher when the current Nimbus verification lists the key (R6)", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable", name: "Tool" }],
      },
    });
    pin("main", tmp);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 90);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const vouch = await signTrustStatement(
      {
        kind: "publisher.verified",
        issuedAt: "2026-10-27T12:00:00Z",
        signerKey: nimbusKey,
        publisherId: "acme",
        keys: [ROOT_KEY],
        github: "acme-dev",
        verifiedAt: "2026-10-20T00:00:00Z",
      },
      seed,
    );
    replaceCurrentVerifications(db, [vouch], nimbusKey, 1);
    const badge = { github: "acme-dev", verifiedAt: "2026-10-20T00:00:00Z" };
    const search = (await call("registry.search", { query: "tool" })) as {
      value: { results: Array<{ verifiedPublisher: unknown }> };
    };
    expect(search.value.results[0]?.verifiedPublisher).toEqual(badge);
    const info = (await call("registry.info", { id: "acme.tool" })) as {
      value: { verifiedPublisher: unknown };
    };
    expect(info.value.verifiedPublisher).toEqual(badge);
    replaceCurrentVerifications(db, [], nimbusKey, 2);
    const after = (await call("registry.search", { query: "tool" })) as {
      value: { results: Array<{ verifiedPublisher: unknown }> };
    };
    expect(after.value.results[0]?.verifiedPublisher).toBeNull();
  });

  test("info returns the registry's report URL, or none (trust layer PR 4a)", async () => {
    const ext = {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable" as const, name: "Tool" }],
      },
    };
    makeRegistry(tmp, ext, 3, { reportUrl: "https://github.com/acme/registry/issues/new" });
    pin("main", tmp);
    const info = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: { reportUrl: unknown };
    };
    expect(info.value.reportUrl).toBe("https://github.com/acme/registry/issues/new");
    makeRegistry(tmp, ext, 4, { reportUrl: "javascript:alert(1)" });
    const bad = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: { reportUrl: unknown };
    };
    expect(bad.value.reportUrl).toBeNull();
  });

  test("info shows the newest version's provenance only when its manifest names the same repository (PR 4c)", async () => {
    const provenance = {
      sourceRepository: "acme/tool",
      commit: "c".repeat(40),
      workflow: ".github/workflows/release.yml@refs/tags/v1.0.0",
      runner: "github-hosted" as const,
      verifiedAt: "2026-10-01T00:00:00Z",
    };
    const info = async (versions: FixtureVersion[], sequence: number) => {
      makeRegistry(tmp, { "acme.tool": { publisherId: "acme", versions } }, sequence);
      const r = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
        value: { provenance: unknown };
      };
      return r.value.provenance;
    };
    pin("main", tmp);
    const v = { version: "1.0.0", channel: "stable" as const, name: "Tool" };
    expect(await info([{ ...v, repository: "acme/tool", provenance }], 3)).toEqual(provenance);
    // The registry recorded it, but the publisher-signed manifest names another repository, or none.
    expect(await info([{ ...v, repository: "evil/tool", provenance }], 4)).toBeNull();
    expect(await info([{ ...v, provenance }], 5)).toBeNull();
    // Malformed provenance in the signed index is no provenance, never a refusal.
    expect(
      await info([{ ...v, repository: "acme/tool", provenance: { commit: "x" } }], 6),
    ).toBeNull();
    // Only the newest version: an older version's provenance is not shown.
    expect(
      await info(
        [
          { ...v, repository: "acme/tool", provenance },
          { version: "1.1.0", channel: "stable", name: "Tool", repository: "acme/tool" },
        ],
        7,
      ),
    ).toBeNull();
  });

  test("info projects each version's registry-measured quality; a malformed one never fails the call", async () => {
    const quality = {
      scorer: 1,
      score: 66,
      cases: 3,
      passed: 2,
      rubrics: {
        exact: { cases: 1, passed: 1 },
        "json-match": { cases: 1, passed: 1 },
        "one-of": { cases: 1, passed: 0 },
      },
    };
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          { version: "1.0.0", channel: "stable", name: "Tool" },
          { version: "1.1.0", channel: "stable", name: "Tool", quality },
          { version: "1.2.0", channel: "stable", name: "Tool", quality: { ...quality, score: 99 } },
        ],
      },
    });
    pin("main", tmp);
    const out = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: { versions: Array<Record<string, unknown>> };
    };
    const [v120, v110, v100] = out.value.versions;
    expect(v120?.["quality"]).toBeNull();
    expect(v120?.["qualityInvalid"]).toBe("quality.score does not match passed and cases");
    expect(v110?.["quality"]).toEqual({ score: 66, cases: 3, passed: 2 });
    expect(v110).not.toHaveProperty("qualityInvalid");
    expect(v100?.["quality"]).toBeNull();
    expect(v100).not.toHaveProperty("qualityInvalid");
  });

  test("a qualityInvalid reason quoting index-chosen key names is capped at 200 characters", async () => {
    const keys = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${String(i)}${"x".repeat(60)}`, 1]),
    );
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable", name: "Tool", quality: keys }],
      },
    });
    pin("main", tmp);
    const out = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: { versions: Array<Record<string, unknown>> };
    };
    const reason = out.value.versions[0]?.["qualityInvalid"];
    expect(out.value.versions[0]?.["quality"]).toBeNull();
    expect(typeof reason).toBe("string");
    expect(String(reason)).toHaveLength(200);
    expect(String(reason)).toStartWith("quality has unexpected keys: k0");
  });

  test("search carries the offered version's quality, never a newer beta's or a malformed one", async () => {
    const quality = (score: number, passed: number) => ({
      scorer: 1,
      score,
      cases: 2,
      passed,
      rubrics: {
        exact: { cases: 2, passed },
        "json-match": { cases: 0, passed: 0 },
        "one-of": { cases: 0, passed: 0 },
      },
    });
    const search = async (versions: FixtureVersion[], sequence: number) => {
      makeRegistry(tmp, { "acme.tool": { publisherId: "acme", versions } }, sequence);
      const r = (await call("registry.search", { query: "tool" })) as {
        value: { results: Array<Record<string, unknown>> };
      };
      return r.value.results[0];
    };
    pin("main", tmp);
    const offered = await search(
      [
        { version: "1.0.0", channel: "stable", name: "Tool", quality: quality(50, 1) },
        { version: "2.0.0-beta.1", channel: "beta", name: "Tool", quality: quality(100, 2) },
      ],
      3,
    );
    expect(offered?.["quality"]).toEqual({ score: 50, cases: 2, passed: 1 });
    // Beta only: the beta is offered, so its quality is shown.
    const betaOnly = await search(
      [{ version: "2.0.0-beta.1", channel: "beta", name: "Tool", quality: quality(100, 2) }],
      4,
    );
    expect(betaOnly?.["quality"]).toEqual({ score: 100, cases: 2, passed: 2 });
    const malformed = await search(
      [{ version: "1.0.0", channel: "stable", name: "Tool", quality: "87" }],
      5,
    );
    expect(malformed?.["quality"]).toBeNull();
  });

  test("search marks an extension whose newest offered version is taken down (I48)", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          { version: "1.0.0", channel: "stable", name: "Tool" },
          { version: "1.1.0", channel: "stable", name: "Tool" },
        ],
      },
    });
    pin("main", tmp);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 60);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const takedown = (versions: string[]) =>
      signTrustStatement(
        {
          kind: "extension.takedown",
          issuedAt: "2026-10-26T12:00:00Z",
          signerKey: nimbusKey,
          extensionId: "acme.tool",
          publisherId: "acme",
          versions,
          reason: "malware",
        },
        seed,
      );
    const search = async () =>
      (
        (await call("registry.search", { query: "tool" })) as {
          value: { results: Array<{ blocked: boolean }> };
        }
      ).value.results[0]?.blocked;
    recordTrustStatements(
      db,
      [await takedown(["1.0.0"])],
      { kind: "feed", nimbusRootKey: nimbusKey },
      1,
    );
    expect(await search()).toBe(false);
    recordTrustStatements(
      db,
      [await takedown(["1.1.0"])],
      { kind: "feed", nimbusRootKey: nimbusKey },
      1,
    );
    expect(await search()).toBe(true);
  });

  test("search reports an unreachable registry and still returns others", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable", name: "Tool" }],
      },
    });
    pin("main", tmp);
    pin("gone", join(other, "missing"));
    const out = (await call("registry.search", { query: "tool" })) as {
      value: {
        results: Array<{ registry: string }>;
        errors: Array<{ registry: string; error: string }>;
      };
    };
    expect(out.value.results.map((r) => r.registry)).toEqual(["main"]);
    expect(out.value.errors).toHaveLength(1);
    expect(out.value.errors[0]?.registry).toBe("gone");
    expect(out.value.errors[0]?.error).toContain("ERR_REGISTRY_");
  });

  test("info without --registry is ambiguous when two registries carry the id", async () => {
    const ext = {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable" as const, name: "Tool" }],
      },
    };
    makeRegistry(tmp, ext);
    makeRegistry(other, ext);
    pin("main", tmp);
    pin("second", other);
    await expect(call("registry.info", { id: "acme.tool" })).rejects.toThrow(
      /ERR_REGISTRY_AMBIGUOUS.*main.*second/,
    );
    const ok = (await call("registry.info", { id: "acme.tool", registry: "second" })) as {
      value: { registry: string };
    };
    expect(ok.value.registry).toBe("second");
  });

  test("info shows permissions from the hash-checked manifest", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          { version: "1.0.0", channel: "stable", name: "Tool" },
          { version: "1.1.0", channel: "beta", name: "Tool" },
        ],
      },
    });
    pin("main", tmp);
    const out = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: Record<string, unknown>;
    };
    expect(out.value).toEqual({
      registry: "main",
      id: "acme.tool",
      publisherId: "acme",
      publisherFingerprint: FINGERPRINT,
      verifiedPublisher: null,
      reportUrl: null,
      provenance: null,
      versions: [
        {
          version: "1.1.0",
          channel: "beta",
          publishedAt: "2026-10-01T00:00:00Z",
          packageSizeBytes: 1234,
          quality: null,
          permissions: { network: ["api.example.com"], filesystem: { read: [], write: [] } },
          access: {
            networkReach: "not known here (the sandbox is not available to ask)",
            fileAccess: "reads none · writes none (not checked here)",
            canRunHere: null,
            checked: false,
          },
        },
        {
          version: "1.0.0",
          channel: "stable",
          publishedAt: "2026-10-01T00:00:00Z",
          packageSizeBytes: 1234,
          quality: null,
        },
      ],
    });
  });

  test("registry.info predicts files with no install path and states the live reach", async () => {
    const readDir = join(tmp, "readable");
    mkdirSync(readDir, { recursive: true });
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          {
            version: "1.0.0",
            channel: "stable",
            name: "Tool",
            filesystem: { read: [readDir], write: [] },
          },
        ],
      },
    });
    pin("main", tmp);
    const out = await dispatchRegistryRpc({
      method: "registry.info",
      params: { id: "acme.tool", registry: "main" },
      db,
      fetch: fetchBag(),
      evidence: {
        homeDir: tmp,
        sandbox: {
          platform: "linux",
          isFullyActive: () => true,
          degradedReason: () => null,
          canConfine: () => null,
        },
        grantEnv: {
          platform: process.platform,
          protectedRoots: [],
          runtimeReadPaths: [],
          realpath: (p: string) => p,
        },
      },
    });
    const access = (out as { value: { versions: Array<{ access: Record<string, unknown> }> } })
      .value.versions[0]?.access;
    expect(access?.["networkReach"]).toBe("network access to api.example.com");
    expect(String(access?.["fileAccess"])).toContain(readDir);
    expect(access?.["checked"]).toBe(true);
    // No install path: the own-files check did not run, and nothing claims it did.
    expect(String(access?.["fileAccess"])).not.toMatch(/can run|own files/i);
  });

  test("only the newest version carries access, as permissions does", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          { version: "1.0.0", channel: "stable", name: "Tool" },
          { version: "1.1.0", channel: "stable", name: "Tool" },
        ],
      },
    });
    pin("main", tmp);
    const out = (await call("registry.info", { id: "acme.tool", registry: "main" })) as {
      value: { versions: Array<{ version: string; access?: unknown }> };
    };
    expect(out.value.versions[0]?.access).toBeDefined();
    expect(out.value.versions[1]?.access).toBeUndefined();
  });

  test("info refuses a manifest whose hash differs from the index", async () => {
    makeRegistry(tmp, {
      "acme.tool": {
        publisherId: "acme",
        versions: [
          {
            version: "1.0.0",
            channel: "stable",
            name: "Tool",
            manifestOverride: JSON.stringify({
              id: "acme.tool",
              version: "1.0.0",
              entry: "x.js",
              permissions: { network: ["evil.example.com"] },
            }),
          },
        ],
      },
    });
    pin("main", tmp);
    await expect(call("registry.info", { id: "acme.tool", registry: "main" })).rejects.toThrow(
      "ERR_REGISTRY_HASH_MISMATCH",
    );
    // `reportOnly` reads the signed index alone, so the extension can still be reported.
    const report = (await call("registry.info", {
      id: "acme.tool",
      registry: "main",
      reportOnly: true,
    })) as { value: Record<string, unknown> };
    expect(report.value).toEqual({ registry: "main", id: "acme.tool", reportUrl: null });
  });

  test("info for an id no registry carries is ERR_REGISTRY_NOT_FOUND", async () => {
    makeRegistry(tmp, {});
    pin("main", tmp);
    await expect(call("registry.info", { id: "nope.tool" })).rejects.toThrow(
      "ERR_REGISTRY_NOT_FOUND",
    );
  });
});

describe("registry.install", () => {
  const events: Array<{ method: string; params: Record<string, unknown> }> = [];
  let extensionsDir: string;

  beforeEach(() => {
    events.length = 0;
    setGatewayEventBroadcast((method, params) => events.push({ method, params }));
    extensionsDir = join(tmp, "installed");
  });

  afterEach(() => {
    setGatewayEventBroadcast(undefined);
  });

  const install = (params: unknown, gate: RegistryOwnerGate | undefined) =>
    dispatchRegistryRpc({
      method: "registry.install",
      params,
      db,
      fetch: fetchBag(),
      extensionsDir,
      vault: new MockVault(),
      ...(gate === undefined ? {} : { ownerGate: gate }),
    });

  test("registry.install emits extension.stateChanged on success and on failure", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const g = gateRecorder(true);
    const out = await install({ id: "acme.tool" }, g.gate);
    expect(out).toMatchObject({
      kind: "hit",
      value: { id: "acme.tool", version: "1.0.0", sourceRegistry: "main" },
    });
    expect(g.asked).toHaveLength(1);
    expect(g.asked[0]).toMatchObject({
      type: "extension.install",
      payload: { sourceRegistry: "main", rootFingerprint: FINGERPRINT },
    });
    expect(events.at(-1)).toMatchObject({
      method: "gateway.event",
      params: {
        kind: "extension.stateChanged",
        payload: { extensionId: "acme.tool", action: "install", ok: true },
      },
    });

    await expect(install({ id: "acme.tool" }, g.gate)).rejects.toThrow(
      "ERR_REGISTRY_ALREADY_INSTALLED",
    );
    expect(events.at(-1)).toMatchObject({
      params: {
        kind: "extension.stateChanged",
        payload: { extensionId: "acme.tool", action: "install", ok: false },
      },
    });
  });

  test("a registry install approval states reach and the file outcome from the evidence", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const g = gateRecorder(true);
    await dispatchRegistryRpc({
      method: "registry.install",
      params: { id: "acme.tool" },
      db,
      fetch: fetchBag(),
      extensionsDir,
      vault: new MockVault(),
      ownerGate: g.gate,
      evidence: { homeDir: tmp },
    });
    const payload = (g.asked[0] as { payload: Record<string, unknown> }).payload;
    expect(payload["networkReach"]).toBe("not known here (the sandbox is not available to ask)");
    expect(String(payload["fileAccess"])).toContain("reads none");
    expect("canRunHere" in payload).toBe(false);
  });

  test("registry.install returns the installed dependencies", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const out = await install({ id: "acme.tool" }, gateRecorder(true).gate);
    expect(out).toMatchObject({ kind: "hit", value: { id: "acme.tool", dependencies: [] } });
  });

  test("registry.install labels the root and each added dependency with its kind", async () => {
    runIndexedSchemaMigrations(db, 79);
    const dir = join(tmp, "reg");
    await buildMultiExtensionRegistry(dir, {
      "acme.pack": [{ version: "1.0.0", starterPack: true, dependsOn: { "acme.dep": "^1.0.0" } }],
      "acme.dep": [{ version: "1.0.0" }],
    });
    pin("main", dir);
    const out = (await install({ id: "acme.pack" }, gateRecorder(true).gate)) as {
      value: { kind: string; dependencies: Array<{ id: string; kind: string }> };
    };
    expect(out.value.kind).toBe("starter-pack");
    expect(out.value.dependencies).toMatchObject([{ id: "acme.dep", kind: "extension" }]);
  });

  test("registry.install names a rollback that left packages behind, and warns it", async () => {
    runIndexedSchemaMigrations(db, 78);
    const dir = join(tmp, "reg");
    await buildMultiExtensionRegistry(dir, {
      "acme.tool": [{ version: "1.0.0", dependsOn: { "acme.dep": "^1.0.0" } }],
      "acme.dep": [{ version: "1.0.0" }],
    });
    pin("main", dir);
    // The plan's edge write fails after both rows commit, and so does each rollback edge clear.
    db.run("DROP TABLE extension_dependency");
    const warned: unknown[] = [];
    let err: unknown;
    try {
      await dispatchRegistryRpc({
        method: "registry.install",
        params: { id: "acme.tool" },
        db,
        fetch: fetchBag(),
        extensionsDir,
        vault: new MockVault(),
        ownerGate: gateRecorder(true).gate,
        logger: { warn: (...args: unknown[]) => void warned.push(args) },
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toEndWith(" (rollback incomplete: acme.tool, acme.dep)");
    expect(warned).toHaveLength(1);
    expect(events.at(-1)?.params).toMatchObject({
      payload: { ok: false, error: (err as Error).message },
    });
  });

  test("registry.install reports the plan's connector requirements", async () => {
    runIndexedSchemaMigrations(db, 78);
    const dir = join(tmp, "reg");
    await buildMultiExtensionRegistry(dir, {
      "acme.tool": [
        {
          version: "1.0.0",
          dependsOn: { "acme.dep": "^1.0.0" },
          requires: { connectors: ["github"] },
        },
      ],
      "acme.dep": [{ version: "1.0.0", requires: { connectors: ["slack"] } }],
    });
    pin("main", dir);
    const g = gateRecorder(true);
    const out = (await install({ id: "acme.tool" }, g.gate)) as {
      value: {
        dependencies: Array<{ id: string }>;
        connectorRequirements: Array<{ connector: string; state: string; requiredBy: string[] }>;
      };
    };
    expect(out.value.dependencies.map((d) => d.id)).toEqual(["acme.dep"]);
    expect(
      out.value.connectorRequirements.map((r) => [r.connector, r.state, r.requiredBy]),
    ).toEqual([
      ["github", "not_connected", ["acme.tool"]],
      ["slack", "not_connected", ["acme.dep"]],
    ]);
    // The approval named them too, before anything was installed.
    const payload = (g.asked[0] as { payload: Record<string, unknown> }).payload;
    expect(payload["planText"]).toContain(
      [
        "Needs:",
        "  github: not connected — run: nimbus connector auth github --token <token>",
        "  slack: not connected — run: nimbus connector auth slack",
      ].join("\n"),
    );
  });

  test("registry.install of an installed dependency promotes it without asking", async () => {
    runIndexedSchemaMigrations(db, 79);
    const dir = join(tmp, "reg");
    await buildMultiExtensionRegistry(dir, {
      "acme.tool": [{ version: "1.0.0", dependsOn: { "acme.dep": "^1.0.0" } }],
      "acme.dep": [{ version: "1.0.0" }],
    });
    pin("main", dir);
    const g = gateRecorder(true);
    await install({ id: "acme.tool" }, g.gate);
    expect(isInstalledAsDependency(db, "acme.dep")).toBe(true);
    events.length = 0;
    const out = await install({ id: "acme.dep" }, g.gate);
    expect(out).toEqual({
      kind: "hit",
      value: {
        id: "acme.dep",
        version: "1.0.0",
        promoted: true,
        sourceRegistry: "main",
        channel: "stable",
      },
    });
    expect(g.asked).toHaveLength(1);
    expect(isInstalledAsDependency(db, "acme.dep")).toBe(false);
    // Nothing was installed, so no install event is reported.
    expect(events.filter((e) => e.params["kind"] === "extension.stateChanged")).toEqual([]);
  });

  test("a failing requirement computation never fails a registry install", async () => {
    runIndexedSchemaMigrations(db, 78);
    const dir = join(tmp, "reg");
    await buildMultiExtensionRegistry(dir, {
      "acme.tool": [
        {
          version: "1.0.0",
          dependsOn: { "acme.dep": "^1.0.0" },
          requires: { connectors: ["github"] },
        },
      ],
      "acme.dep": [{ version: "1.0.0", requires: { connectors: ["slack"] } }],
    });
    pin("main", dir);
    const g = gateRecorder(true);
    const out = (await dispatchRegistryRpc({
      method: "registry.install",
      params: { id: "acme.tool" },
      db,
      fetch: fetchBag(),
      extensionsDir,
      vault: new MockVault(),
      ownerGate: g.gate,
      requirementStatuses: () => Promise.reject(new Error("requirements unavailable")),
    })) as { value: Record<string, unknown> };
    expect(out.value["id"]).toBe("acme.tool");
    expect("connectorRequirements" in out.value).toBe(false);
    // The approval was asked without requirements and without a Needs block.
    const payload = (g.asked[0] as { payload: Record<string, unknown> }).payload;
    expect("connectorRequirements" in payload).toBe(false);
    expect(payload["planText"]).not.toContain("Needs:");
    // Reported as the success it is, never as a failed install.
    const installEvents = events.filter((e) => e.params["kind"] === "extension.stateChanged");
    expect(installEvents.map((e) => (e.params["payload"] as { ok: boolean }).ok)).toEqual([true]);
  });

  test("a trust feed that cannot be refreshed first is disclosed in the install prompt", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const g = gateRecorder(true);
    let refreshed = 0;
    await dispatchRegistryRpc({
      method: "registry.install",
      params: { id: "acme.tool" },
      db,
      fetch: fetchBag(),
      extensionsDir,
      vault: new MockVault(),
      ownerGate: g.gate,
      trustFeed: {
        config: { url: "https://trust.example/", rootKey: ROOT_KEY },
        refreshNow: () => {
          refreshed++;
          return Promise.resolve({
            status: "refused",
            code: "ERR_REGISTRY_UNREACHABLE",
            detail: "x",
          });
        },
      },
    });
    expect(refreshed).toBe(1);
    const payload = (g.asked[0] as { payload: Record<string, unknown> }).payload;
    expect(payload["trustFeedNote"]).toContain("the trust feed could not be refreshed");
  });

  test("a blocked install is a registry-class refusal (-32000) carrying its code", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 61);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const s = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: "acme.tool",
        publisherId: "acme",
        versions: "*",
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(db, [s], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    const err = await install({ id: "acme.tool" }, gateRecorder(true).gate).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ rpcCode: -32000 });
    expect((err as Error).message).toMatch(/^ERR_EXTENSION_TAKEN_DOWN:/);
  });

  test("acceptPublisherKey must be a fingerprint, checked before anything runs", async () => {
    for (const bad of ["nope", 7, "A".repeat(32)]) {
      await expect(
        install({ id: "acme.tool", acceptPublisherKey: bad }, gateRecorder(true).gate),
      ).rejects.toThrow("ERR_INVALID_PARAMS");
    }
  });

  test("with no trust feed configured the prompt carries no note", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    const g = gateRecorder(true);
    await install({ id: "acme.tool" }, g.gate);
    expect((g.asked[0] as { payload: Record<string, unknown> }).payload).not.toHaveProperty(
      "trustFeedNote",
    );
  });

  test("a denied approval is an internal-class error and installs nothing", async () => {
    const dir = join(tmp, "reg");
    await buildTestRegistry(dir, { id: "acme.tool", versions: [{ version: "1.0.0" }] });
    pin("main", dir);
    await expect(install({ id: "acme.tool" }, gateRecorder(false).gate)).rejects.toMatchObject({
      rpcCode: -32603,
    });
  });

  test("it refuses without the owner gate, and rejects a bad channel before anything runs", async () => {
    await expect(install({ id: "acme.tool" }, undefined)).rejects.toThrow("HITL gate");
    await expect(
      install({ id: "acme.tool", channel: "nightly" }, gateRecorder(true).gate),
    ).rejects.toThrow("ERR_INVALID_PARAMS");
  });
});

describe("the reserved built-in registry name", () => {
  /** A fixture built-in registry: the official root key, served from `tmp`. */
  const builtinBag = (): RegistryFetchBag => fetchBag({ builtin: { url: tmp, rootKey: ROOT_KEY } });

  test("registry add nimbus-trust (the trust feed's ledger name) refused, naming the feed", async () => {
    const g = gateRecorder(true);
    for (const name of ["nimbus-trust", " Nimbus-Trust "]) {
      await expect(call("registry.add", { name, url: tmp }, { gate: g.gate })).rejects.toThrow(
        /ERR_REGISTRY_NAME_RESERVED.*trust feed/,
      );
    }
    expect(g.asked).toEqual([]);
    expect(ledgerCount()).toBe(0);
  });

  test("registry add nimbus-official refused", async () => {
    const g = gateRecorder(true);
    let fetched = 0;
    const bag = fetchBag({
      builtin: { url: tmp, rootKey: ROOT_KEY },
      fetchFn: () => {
        fetched += 1;
        return Promise.reject(new Error("unexpected network"));
      },
    });
    // Every spelling that would reach the stored name, refused outright: no fetch, no prompt, no
    // row, and no exception for the official URL and key themselves.
    for (const name of [
      "nimbus-official",
      "  nimbus-official ",
      "Nimbus-Official",
      "NIMBUS-OFFICIAL",
    ]) {
      await expect(
        call("registry.add", { name, url: tmp }, { gate: g.gate, fetch: bag }),
      ).rejects.toThrow("ERR_REGISTRY_NAME_RESERVED");
      await expect(
        call(
          "registry.add",
          { name, url: "https://elsewhere.test/", fingerprint: FINGERPRINT },
          { gate: g.gate, fetch: bag },
        ),
      ).rejects.toThrow("ERR_REGISTRY_NAME_RESERVED");
    }
    // Refused with the production default (no builtin configured) too: the name is reserved, full stop.
    await expect(
      call("registry.add", { name: "nimbus-official", url: tmp }, { gate: g.gate }),
    ).rejects.toThrow("ERR_REGISTRY_NAME_RESERVED");
    expect(g.asked).toEqual([]);
    expect(fetched).toBe(0);
    expect(ledgerCount()).toBe(0);
    expect(getRegistry(db, "nimbus-official")).toBeUndefined();
    // The store refuses it too, whoever calls it.
    expect(() =>
      insertRegistry(db, {
        name: "nimbus-official",
        url: tmp,
        rootKey: ROOT_KEY,
        rootFingerprint: FINGERPRINT,
        lastSequence: 0,
        lastGeneratedAt: "2026-10-01T00:00:00Z",
        addedAt: 1,
        lastIndexSha256: null,
      }),
    ).toThrow("ERR_REGISTRY_NAME_RESERVED");
    // The official URL and root key under ANOTHER name stay the owner's HITL decision.
    const out = await call(
      "registry.add",
      { name: "official", url: tmp, fingerprint: FINGERPRINT },
      { gate: g.gate, fetch: builtinBag() },
    );
    expect(out).toMatchObject({
      kind: "hit",
      value: { name: "official", rootFingerprint: FINGERPRINT },
    });
    expect(g.asked).toHaveLength(1);
  });

  test("info on a built-in extension falls back to the baked report URL; never for another registry", async () => {
    const ext = {
      "acme.tool": {
        publisherId: "acme",
        versions: [{ version: "1.0.0", channel: "stable" as const, name: "Tool" }],
      },
    };
    makeRegistry(tmp, ext);
    const baked = "https://github.com/nimbus-agent/nimbus-mcp-servers/issues/new";
    const withReport = fetchBag({ builtin: { url: tmp, rootKey: ROOT_KEY, reportUrl: baked } });
    const info = (await call(
      "registry.info",
      { id: "acme.tool", registry: "nimbus-official", reportOnly: true },
      { fetch: withReport },
    )) as { value: Record<string, unknown> };
    expect(info.value).toEqual({ registry: "nimbus-official", id: "acme.tool", reportUrl: baked });
    // A built-in config that names no report URL yields none.
    const none = (await call(
      "registry.info",
      { id: "acme.tool", registry: "nimbus-official", reportOnly: true },
      { fetch: builtinBag() },
    )) as { value: { reportUrl: unknown } };
    expect(none.value.reportUrl).toBeNull();
    // The same index under an owner registry never borrows the official destination.
    pin("main", tmp);
    const owner = (await call(
      "registry.info",
      { id: "acme.tool", registry: "main", reportOnly: true },
      { fetch: withReport },
    )) as { value: { reportUrl: unknown } };
    expect(owner.value.reportUrl).toBeNull();
  });

  test("registry list does not show the builtin", async () => {
    const empty = await call("registry.list", {}, { fetch: builtinBag() });
    expect(empty).toEqual({ kind: "hit", value: { registries: [] } });
    insertRegistry(db, {
      name: "community",
      url: "/r/community",
      rootKey: ROOT_KEY,
      rootFingerprint: FINGERPRINT,
      lastSequence: 1,
      lastGeneratedAt: "2026-10-10T00:00:00Z",
      addedAt: 1,
      lastIndexSha256: null,
    });
    const one = await call("registry.list", {}, { fetch: builtinBag() });
    const value = (one as { value: { registries: Array<Record<string, unknown>> } }).value;
    expect(value.registries.map((r) => r["name"])).toEqual(["community"]);
  });
});
