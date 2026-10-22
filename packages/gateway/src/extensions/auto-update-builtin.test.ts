/**
 * Auto-update APPLY for an extension installed from the BUILT-IN registry and bound to a legacy
 * connector through the continuity table (pr7 task 7.3, ruling B32). A bound extension updates only
 * through this path, so it is exercised end to end here against a FIXTURE built-in registry (served
 * "remotely" from a folder by a fake `fetchFn`) and a FIXTURE continuity entry — never the baked
 * ones, and never the network.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import { listExtensions } from "../automation/extension-store.ts";
import {
  createExtensionCredentialsResolver,
  listExtensionIdentities,
} from "../connectors/extension-sync/extension-identity.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import { approveExtensionRun } from "./approve-run.ts";
import { createAutoUpdateRuntime } from "./auto-update-init.ts";
import { _resetAutoUpdateMutexForTests, dispatchAutoUpdateRpc } from "./auto-update-rpc.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import {
  buildTestRegistry,
  resignIndex,
  type TestVersion,
} from "./registry/__fixtures__/build-test-registry.ts";
import { BUILTIN_REGISTRY_NAME, type BuiltinRegistryConfig } from "./registry/builtin-registry.ts";
import { installFromRegistry } from "./registry/install-from-registry.ts";
import type { RegistryFetchDeps } from "./registry/registry-fetch.ts";
import { getExtensionSource, listRegistries } from "./registry/registry-store.ts";
import { getRunGrant } from "./run-grant-store.ts";
import { readVerifiedExtensionForSpawn } from "./verified-extension.ts";
import { encodeBase64, generateEd25519Keypair } from "./verify-signature.ts";

const EXT_ID = "com.example.bound";
const CODE_SERVER_ID = "ext_com_example_bound";
const LEGACY_ID = "fixturelegacy";
// audit-ignore-next-line D11-vault-key (fixture legacy key a binding maps from, not a vault-key construction)
const LEGACY_VAULT_KEY = "fixturelegacy.token";
const BUILTIN_HOST = "registry.nimbus.test";
const BUILTIN_URL = `https://${BUILTIN_HOST}/`;
const MANIFEST_EXTRA = { credentials: { token: { env: "FIXTURE_TOKEN" } } };

let tmp: string;
let db: Database;
let builtinDir: string;
let extensionsDir: string;
let vault: MockVault;
let builtin: BuiltinRegistryConfig;
let entry: ContinuityEntry;
let env: ExtensionRunGrantEnv;
/** Every URL the fake network was asked for, in order. */
let requests: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-au-builtin-"));
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  builtinDir = join(tmp, "official");
  extensionsDir = join(tmp, "extensions");
  vault = new MockVault();
  requests = [];
  env = {
    platform: process.platform,
    protectedRoots: [join(tmp, "data"), join(tmp, "config")],
    runtimeReadPaths: [join(tmp, "bun-bin")],
    realpath: (p) => realpathSync.native(p),
  };
});

afterEach(() => {
  _resetAutoUpdateMutexForTests();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** (Re)publishes the fixture built-in registry with `versions`, at index sequence `sequence`. */
async function publishBuiltin(versions: TestVersion[], sequence: number): Promise<void> {
  const built = await buildTestRegistry(builtinDir, {
    id: EXT_ID,
    versions,
    manifestExtra: MANIFEST_EXTRA,
  });
  const indexPath = join(builtinDir, "index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, unknown>;
  resignIndex(indexPath, { ...index, sequence });
  builtin = { url: BUILTIN_URL, rootKey: built.rootKey };
  entry = {
    legacyServiceId: LEGACY_ID,
    extensionId: EXT_ID,
    publisherKey: built.publisherKey,
    sourceRootFingerprint: publisherKeyFingerprint(built.rootKey),
    credentials: { token: LEGACY_VAULT_KEY },
    expectedPermissions: { network: [], read: [], write: [] },
    itemTypes: [],
  };
}

/** Registry fetch deps resolving the reserved name to `cfg`, served from `builtinDir`. */
function fetchBag(cfg: BuiltinRegistryConfig): Omit<RegistryFetchDeps, "db"> {
  return {
    fetchFn: async (url) => {
      requests.push(url);
      const u = new URL(url);
      if (u.host !== BUILTIN_HOST) return new Response("unknown", { status: 503 });
      try {
        return new Response(
          readFileSync(join(builtinDir, ...u.pathname.split("/").filter(Boolean))),
        );
      } catch {
        return new Response("missing", { status: 404 });
      }
    },
    enforceAirGap: () => false,
    now: () => Date.now(),
    production: false,
    builtin: cfg,
  };
}

/** Ids `onUpdateApplied` was called with: production wires the extension sync host's refresh here. */
let applied: string[];

function runtimeFor(cfg: BuiltinRegistryConfig) {
  applied = [];
  return createAutoUpdateRuntime({
    db,
    vault,
    extensionsDir,
    dataDir: join(tmp, "data"),
    fetch: fetchBag(cfg),
    intervalHours: 24,
    onUpdateApplied: (id) => applied.push(id),
  });
}

function approve(gateCalls: string[]) {
  return approveExtensionRun(EXT_ID, {
    db,
    env,
    gate: async (a) => {
      gateCalls.push(a.type);
      return true;
    },
    runtimeEnabled: true,
    now: () => 1,
    continuityTable: [entry],
  });
}

function installedVersion(): string | undefined {
  return listExtensions(db).find((r) => r.id === EXT_ID)?.version;
}

function builtinSequence(): number | undefined {
  const r = db
    .query("SELECT last_sequence FROM builtin_registry_state WHERE name = ?")
    .get(BUILTIN_REGISTRY_NAME) as { last_sequence: number } | null;
  return r?.last_sequence;
}

/** Steps 1–2: install the bound extension from the fixture built-in, approve it, publish 0.2.1. */
async function installedApprovedThenPublished(): Promise<void> {
  await publishBuiltin([{ version: "0.2.0" }], 1);
  const out = await installFromRegistry(
    { db, extensionsDir, vault, fetch: fetchBag(builtin), approve: async () => true },
    { id: EXT_ID },
  );
  expect(out.sourceRegistry).toBe(BUILTIN_REGISTRY_NAME);
  const gateCalls: string[] = [];
  await approve(gateCalls);
  expect(gateCalls).toEqual(["extension.run"]);
  // Premise: bound. The grant reads the LEGACY Vault key and the index id is the legacy id.
  expect(getRunGrant(db, EXT_ID)).toMatchObject({
    service_id: CODE_SERVER_ID,
    version: "0.2.0",
    credentials_json: JSON.stringify({
      token: { env: "FIXTURE_TOKEN", vaultKey: LEGACY_VAULT_KEY },
    }),
  });
  expect(listExtensionIdentities(db, [entry]).map((e) => e.identity.indexServiceId)).toEqual([
    LEGACY_ID,
  ]);

  await publishBuiltin([{ version: "0.2.0" }, { version: "0.2.1" }], 2);
}

describe("auto-update of a bound extension installed from the built-in registry (B32)", () => {
  test("builtin-sourced bound extension: update detected, apply re-verifies via resolveRegistry, binding + grant credentials unchanged", async () => {
    await installedApprovedThenPublished();
    const grantBefore = getRunGrant(db, EXT_ID);
    const runtime = runtimeFor(builtin);

    // 3. Detection (the daemon's own poll, i.e. `collectRegistryUpdates`) sees 0.2.1 in the built-in.
    await runtime.deps.forcePoll();
    const cached = runtime.deps.cache.get(EXT_ID);
    expect(cached).toMatchObject({
      fromVersion: "0.2.0",
      toVersion: "0.2.1",
      sourceRegistry: BUILTIN_REGISTRY_NAME,
      rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
      verificationStatus: "verified",
    });
    if (cached === undefined) throw new Error("no update detected");
    expect(builtinSequence()).toBe(2);
    expect(await runtime.deps.isSourceCurrent?.(cached)).toBe(true);

    // 4. Apply: re-fetches and re-verifies the built-in's signed index and manifest (resolved by the
    // reserved name, never an owner row), then downloads and installs the package.
    requests = [];
    await runtime.deps.performUpgrade(cached);
    // The applied-update hook fires once. What production does with it (pause the INDEX id with the
    // re-approve reason) is `register-extension-sync.test.ts` "applied update pauses with the
    // re-approve reason".
    expect(applied).toEqual([EXT_ID]);
    expect(requests).toEqual([
      `${BUILTIN_URL}index.json`,
      `${BUILTIN_URL}extensions/${EXT_ID}/0.2.1/manifest.json`,
      `${BUILTIN_URL}extensions/${EXT_ID}/0.2.1/package.tgz`,
    ]);
    expect(installedVersion()).toBe("0.2.1");
    expect(readFileSync(join(extensionsDir, EXT_ID, "dist", "index.js"), "utf8")).toContain(
      "0.2.1",
    );
    // The source is unchanged and the built-in path wrote no owner registry row.
    expect(getExtensionSource(db, EXT_ID)).toEqual({
      registry: BUILTIN_REGISTRY_NAME,
      rootFingerprint: publisherKeyFingerprint(builtin.rootKey),
      channel: "stable",
    });
    expect(listRegistries(db)).toEqual([]);

    // 5. The binding still holds on the updated code: same index id, same legacy credential.
    expect(
      listExtensionIdentities(db, [entry]).map(({ identity }) => ({
        codeServerId: identity.codeServerId,
        indexServiceId: identity.indexServiceId,
      })),
    ).toEqual([{ codeServerId: CODE_SERVER_ID, indexServiceId: LEGACY_ID }]);
    const resolveCreds = createExtensionCredentialsResolver(db, [entry]);
    expect(resolveCreds(LEGACY_ID)).toEqual({
      token: { env: "FIXTURE_TOKEN", vaultKey: LEGACY_VAULT_KEY },
    });

    // The run grant follows the existing update rules: the update does not touch it, so it still
    // names 0.2.0 and the old tree digest (credentials unchanged) and the I43 pre-spawn check
    // refuses it until the owner re-approves.
    expect(getRunGrant(db, EXT_ID)).toEqual(grantBefore);
    const stale = await readVerifiedExtensionForSpawn(EXT_ID, {
      db,
      vault,
      env,
      continuityTable: [entry],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(stale).toBeInstanceOf(Error);
    // The new tree's digest is not the one the grant approved (step 5 of the I43 order).
    expect((stale as { code?: unknown }).code).toBe("ERR_EXTENSION_RUN_TREE_CHANGED");

    // Re-approval is an `extension.run` prompt; the grant it stores still reads the legacy key.
    const gateCalls: string[] = [];
    expect((await approve(gateCalls)).changed).toBe(true);
    expect(gateCalls).toEqual(["extension.run"]);
    expect(getRunGrant(db, EXT_ID)).toMatchObject({
      service_id: CODE_SERVER_ID,
      version: "0.2.1",
      credentials_json: grantBefore?.credentials_json,
    });
    const spawn = await readVerifiedExtensionForSpawn(EXT_ID, {
      db,
      vault,
      env,
      continuityTable: [entry],
    });
    expect(spawn).toMatchObject({
      serviceId: CODE_SERVER_ID,
      version: "0.2.1",
      credentials: { token: { env: "FIXTURE_TOKEN", vaultKey: LEGACY_VAULT_KEY } },
    });
  });

  test("re-pinned builtin root → source_registry_changed", async () => {
    await installedApprovedThenPublished();
    const detecting = runtimeFor(builtin);
    await detecting.deps.forcePoll();
    const cached = detecting.deps.cache.get(EXT_ID);
    if (cached === undefined) throw new Error("no update detected");

    // The release now pins another root key for the built-in registry (same URL).
    const repinned = runtimeFor({
      url: BUILTIN_URL,
      rootKey: encodeBase64(generateEd25519Keypair().pubkey),
    });
    requests = [];
    let asked = false;
    const res = (await dispatchAutoUpdateRpc(
      "extension.update",
      { id: EXT_ID, toVersion: "0.2.1" },
      {
        ...repinned.deps,
        cache: detecting.deps.cache,
        gate: async () => {
          asked = true;
          return "proceed" as const;
        },
      },
    )) as { applied: boolean; reason?: string; hint?: string };
    expect(res).toMatchObject({ applied: false, reason: "source_registry_changed" });
    expect(res.hint).toContain(`source registry ${BUILTIN_REGISTRY_NAME} was removed or re-pinned`);
    expect(asked).toBe(false);
    // Apply itself refuses the same way (not as a signature failure), before any request.
    await expect(repinned.deps.performUpgrade(cached)).rejects.toThrow(
      /^source_registry_changed: /,
    );
    expect(requests).toEqual([]);
    expect(installedVersion()).toBe("0.2.0");
    expect(applied).toEqual([]);
    // Detection under the re-pinned root offers nothing: the install's trust root is not the built-in's.
    await repinned.deps.forcePoll();
    expect(repinned.deps.cache.list()).toEqual([]);
    expect(requests).toEqual([]);
    expect(listRegistries(db)).toEqual([]);
  });
});
