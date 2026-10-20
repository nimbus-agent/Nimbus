import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import { MockVault } from "../../vault/mock.ts";
import { verifyManifestSignature } from "../verify-signature.ts";
import { buildTestRegistry, type TestVersion } from "./__fixtures__/build-test-registry.ts";
import {
  BUILTIN_REGISTRY,
  BUILTIN_REGISTRY_NAME,
  type BuiltinRegistryConfig,
  recordAnyRegistryFetch,
  resolveRegistry,
} from "./builtin-registry.ts";
import { installFromRegistry } from "./install-from-registry.ts";
import { fetchVerifiedIndex, type RegistryFetchDeps } from "./registry-fetch.ts";
import { registryTargets } from "./registry-resolve.ts";
import { getExtensionSource, insertRegistry, listRegistries } from "./registry-store.ts";
import { collectRegistryUpdates, type InstalledRegistryRow } from "./registry-update-source.ts";

const ID = "com.nimbus.readwise";
/** The fixture builtin is served "remotely" from a folder by a fake `fetchFn`. */
const BUILTIN_URL = "https://registry.nimbus.test/";
const NOW = Date.parse("2026-10-20T12:00:00Z");

let db: Database;
let tmp: string;
let builtinDir: string;
let builtin: BuiltinRegistryConfig;

beforeEach(async () => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 73);
  tmp = mkdtempSync(join(tmpdir(), "nimbus-builtin-reg-"));
  builtinDir = join(tmp, "official");
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function buildBuiltin(versions: TestVersion[] = [{ version: "1.0.0" }]): Promise<void> {
  const built = await buildTestRegistry(builtinDir, { id: ID, versions });
  builtin = { url: BUILTIN_URL, rootKey: built.rootKey };
}

function fetchBag(cfg: BuiltinRegistryConfig | null | undefined): Omit<RegistryFetchDeps, "db"> {
  return {
    fetchFn: async (url) => {
      const u = new URL(url);
      if (u.host !== "registry.nimbus.test") return new Response("unknown", { status: 503 });
      try {
        return new Response(
          readFileSync(join(builtinDir, ...u.pathname.split("/").filter(Boolean))),
        );
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
    enforceAirGap: () => false,
    now: () => NOW,
    production: false,
    ...(cfg === undefined ? {} : { builtin: cfg }),
  };
}

const deps = (cfg: BuiltinRegistryConfig | null | undefined): RegistryFetchDeps => ({
  ...fetchBag(cfg),
  db,
});

function addOwnerRegistry(name: string, rootKey: string, url = join(tmp, name)): void {
  insertRegistry(db, {
    name,
    url,
    rootKey,
    rootFingerprint: publisherKeyFingerprint(rootKey),
    lastSequence: 0,
    lastGeneratedAt: "2026-10-01T00:00:00Z",
    addedAt: 1,
  });
}

function builtinState(): unknown {
  return db
    .query(
      "SELECT name, last_sequence, last_generated_at, last_fetched_at FROM builtin_registry_state",
    )
    .all();
}

function registryLedger(): Array<{ destination: string; method: string }> {
  return db
    .query("SELECT destination, method FROM egress_ledger WHERE source_type = 'registry'")
    .all() as Array<{ destination: string; method: string }>;
}

async function refusal(p: Promise<unknown>): Promise<RegistryError> {
  const settled = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(settled).toBeInstanceOf(RegistryError);
  return settled as RegistryError;
}

describe("the built-in official registry", () => {
  test("bare extension install with no registries configured uses the builtin", async () => {
    await buildBuiltin();
    const out = await installFromRegistry(
      {
        db,
        extensionsDir: join(tmp, "extensions"),
        vault: new MockVault(),
        fetch: fetchBag(builtin),
        approve: async () => true,
      },
      { id: ID },
    );
    expect(out.sourceRegistry).toBe(BUILTIN_REGISTRY_NAME);
    expect(getExtensionSource(db, ID)).toEqual({
      registry: BUILTIN_REGISTRY_NAME,
      rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
      channel: "stable",
    });
    // Its sequence lives in the gateway-owned table, never as an owner registry row.
    expect(builtinState()).toEqual([
      {
        name: BUILTIN_REGISTRY_NAME,
        last_sequence: 1,
        last_generated_at: "2026-10-18T12:00:00Z",
        last_fetched_at: NOW,
      },
    ]);
    expect(listRegistries(db)).toEqual([]);
    // A remote registry: every request it made was ledgered, under its reserved name (I29 D22(h)).
    expect(registryLedger()).toEqual([
      { destination: BUILTIN_REGISTRY_NAME, method: "registry.index" },
      { destination: BUILTIN_REGISTRY_NAME, method: "registry.manifest" },
      { destination: BUILTIN_REGISTRY_NAME, method: "registry.package" },
    ]);
  });

  test("builtin omitted when an owner registry has the official root fingerprint", async () => {
    await buildBuiltin();
    // Another trust root: the builtin joins the bare targets.
    addOwnerRegistry("community", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(registryTargets(deps(builtin), undefined).map((r) => r.name)).toEqual([
      "community",
      BUILTIN_REGISTRY_NAME,
    ]);
    // The owner added the official registry under a name of their own: listing it twice would trip
    // I44's two-registries refusal for every official extension.
    addOwnerRegistry("official-mirror", builtin.rootKey, BUILTIN_URL);
    expect(registryTargets(deps(builtin), undefined).map((r) => r.name)).toEqual([
      "community",
      "official-mirror",
    ]);
  });

  test("fetchVerifiedIndex works for the builtin registry and records its sequence", async () => {
    await buildBuiltin();
    const reg = resolveRegistry(db, BUILTIN_REGISTRY_NAME, builtin);
    expect(reg).toMatchObject({
      name: BUILTIN_REGISTRY_NAME,
      url: BUILTIN_URL,
      rootKey: builtin.rootKey,
      rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
      lastSequence: 0,
    });
    if (reg === undefined) throw new Error("unreachable");
    const index = await fetchVerifiedIndex(deps(builtin), reg);
    expect(index.sequence).toBe(1);
    expect(builtinState()).toEqual([
      {
        name: BUILTIN_REGISTRY_NAME,
        last_sequence: 1,
        last_generated_at: "2026-10-18T12:00:00Z",
        last_fetched_at: NOW,
      },
    ]);
    expect(resolveRegistry(db, BUILTIN_REGISTRY_NAME, builtin)?.lastSequence).toBe(1);
    expect(registryLedger()).toEqual([
      { destination: BUILTIN_REGISTRY_NAME, method: "registry.index" },
    ]);
  });

  test("builtin rollback refused", async () => {
    await buildBuiltin();
    const stale = resolveRegistry(db, BUILTIN_REGISTRY_NAME, builtin);
    if (stale === undefined) throw new Error("unreachable");
    expect(recordAnyRegistryFetch(db, stale, 5, "2026-10-19T00:00:00Z", 7)).toBe(true);
    // A lower sequence never lowers the floor.
    expect(recordAnyRegistryFetch(db, stale, 4, "2026-10-19T01:00:00Z", 8)).toBe(false);
    // The index serves sequence 1. A fresh resolve refuses it up front ...
    const fresh = resolveRegistry(db, BUILTIN_REGISTRY_NAME, builtin);
    if (fresh === undefined) throw new Error("unreachable");
    const e1 = await refusal(fetchVerifiedIndex(deps(builtin), fresh));
    expect(e1.code).toBe("ERR_REGISTRY_ROLLBACK");
    // ... and a snapshot taken before the floor moved is refused by the conditional write, as a
    // rollback, not as a removed/re-pinned registry.
    const e2 = await refusal(fetchVerifiedIndex(deps(builtin), stale));
    expect(e2.code).toBe("ERR_REGISTRY_ROLLBACK");
    expect(builtinState()).toEqual([
      {
        name: BUILTIN_REGISTRY_NAME,
        last_sequence: 5,
        last_generated_at: "2026-10-19T00:00:00Z",
        last_fetched_at: 7,
      },
    ]);
  });

  test("collectRegistryUpdates sees an extension sourced from the builtin registry", async () => {
    await buildBuiltin([{ version: "1.0.0" }, { version: "1.1.0" }]);
    const installed: InstalledRegistryRow = {
      id: ID,
      version: "1.0.0",
      enabled: 1,
      source: {
        registry: BUILTIN_REGISTRY_NAME,
        rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
        channel: "stable",
      },
      publisherId: "acme",
      manifest: {
        id: ID,
        version: "1.0.0",
        updateChannel: "stable",
        permissions: { network: [], filesystem: { read: [], write: [] } },
      },
    };
    const out = await collectRegistryUpdates(
      {
        db,
        fetch: deps(builtin),
        vault: new MockVault(),
        verifyManifestSignature: (m, k) =>
          verifyManifestSignature(m as Parameters<typeof verifyManifestSignature>[0], k),
        now: () => 42,
      },
      [installed],
      new AbortController().signal,
    );
    expect(out.errors).toEqual([]);
    expect(out.updates).toHaveLength(1);
    expect(out.updates[0]).toMatchObject({
      id: ID,
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      sourceRegistry: BUILTIN_REGISTRY_NAME,
      rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
    });
    // The same extension with the production default (no builtin) sees nothing, as today.
    const none = await collectRegistryUpdates(
      {
        db,
        fetch: deps(undefined),
        vault: new MockVault(),
        verifyManifestSignature: async () => {},
        now: () => 42,
      },
      [installed],
      new AbortController().signal,
    );
    expect(none.updates).toEqual([]);
  });

  test("with the production default (null) a bare install's targets are the owner list", async () => {
    await buildBuiltin();
    expect(BUILTIN_REGISTRY).toBeNull();
    expect(resolveRegistry(db, BUILTIN_REGISTRY_NAME)).toBeUndefined();
    expect(registryTargets(deps(undefined), undefined)).toEqual([]);
    addOwnerRegistry("community", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect(registryTargets(deps(undefined), undefined)).toEqual(listRegistries(db));
    expect(registryTargets(deps(null), undefined)).toEqual(listRegistries(db));
    const e = (() => {
      try {
        registryTargets(deps(undefined), BUILTIN_REGISTRY_NAME);
        return undefined;
      } catch (err) {
        return err;
      }
    })();
    expect((e as RegistryError).code).toBe("ERR_REGISTRY_NOT_FOUND");
  });

  test("a named --registry nimbus-official resolves the builtin when one is configured", async () => {
    await buildBuiltin();
    expect(registryTargets(deps(builtin), BUILTIN_REGISTRY_NAME).map((r) => r.name)).toEqual([
      BUILTIN_REGISTRY_NAME,
    ]);
  });
});
