import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { insertExtensionRow, listExtensions } from "../../automation/extension-store.ts";
import { dbRun } from "../../db/write.ts";
import type { ContinuityEntry } from "../../extensions/continuity/continuity-table.ts";
import { createExtensionSlotSource } from "../../extensions/extension-runtime.ts";
import type { ExtensionManifest } from "../../extensions/manifest.ts";
import { type ExtensionRunGrantRow, upsertRunGrant } from "../../extensions/run-grant-store.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { isConnectorConfigured } from "../../sync/connector-configured.ts";
import { createMockVault } from "../../vault/mock.ts";
import {
  createExtensionCredentialsResolver,
  indexServiceIdForCodeServer,
  listExtensionIdentities,
  resolveExtensionIdentity,
} from "./extension-identity.ts";

const KEY = `${"A".repeat(43)}=`;
const OFFICIAL_FP = "fp-official-root";
const EXT_ID = "com.nimbus.readwise";
const CODE_ID = "ext_com_nimbus_readwise";

const READWISE: ContinuityEntry = {
  legacyServiceId: "readwise",
  extensionId: EXT_ID,
  publisherKey: KEY,
  sourceRootFingerprint: OFFICIAL_FP,
  credentials: { token: "readwise.token" },
  expectedPermissions: { network: ["readwise.io"], read: [], write: [] },
  itemTypes: ["highlight", "book"],
};
const TABLE = [READWISE];

function manifest(key: string = KEY): ExtensionManifest {
  return {
    id: EXT_ID,
    version: "1.0.0",
    publisher: { name: "Nimbus", key },
  } as unknown as ExtensionManifest;
}

function seed(opts: { fingerprint: string | null; credentialsJson?: string }): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  insertExtensionRow(db, {
    id: EXT_ID,
    version: "1.0.0",
    install_path: join(process.cwd(), "nowhere"),
    manifest_hash: "h",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
  dbRun(db, "UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", [
    opts.fingerprint,
    EXT_ID,
  ]);
  upsertRunGrant(db, {
    extension_id: EXT_ID,
    service_id: CODE_ID,
    version: "1.0.0",
    tree_digest: "d",
    permissions_json: "{}",
    model_access: 0,
    approved_at: 1,
    credentials_json:
      opts.credentialsJson ??
      JSON.stringify({ token: { env: "READWISE_TOKEN", vaultKey: "readwise.token" } }),
  });
  return db;
}

const GRANT: ExtensionRunGrantRow = {
  extension_id: EXT_ID,
  service_id: CODE_ID,
  version: "1.0.0",
  tree_digest: "d",
  permissions_json: "{}",
  model_access: 0,
  approved_at: 1,
  credentials_json: "{}",
};

function identityFor(db: Database, m: ExtensionManifest) {
  const row = listExtensions(db)[0];
  if (row === undefined) throw new Error("no row");
  return resolveExtensionIdentity(row, m, GRANT, TABLE);
}

describe("resolveExtensionIdentity", () => {
  test("bound extension indexes as readwise", () => {
    const id = identityFor(seed({ fingerprint: OFFICIAL_FP }), manifest());
    expect(id.indexServiceId).toBe("readwise");
    expect(id.codeServerId).toBe(CODE_ID);
    expect(id.binding).toBe(READWISE);
  });

  test("same id+key under a different root key does not bind", () => {
    const id = identityFor(seed({ fingerprint: "fp-someone-else" }), manifest());
    expect(id.indexServiceId).toBe(CODE_ID);
    expect(id.binding).toBeUndefined();
  });

  test("owner registry pinned to the official root key binds", () => {
    // The registry's NAME is not an input: only its root fingerprint is.
    const db = seed({ fingerprint: OFFICIAL_FP });
    dbRun(db, "UPDATE extension SET source_registry = ? WHERE id = ?", ["my-mirror", EXT_ID]);
    expect(identityFor(db, manifest()).indexServiceId).toBe("readwise");
  });

  test("a local install never binds", () => {
    expect(identityFor(seed({ fingerprint: null }), manifest()).indexServiceId).toBe(CODE_ID);
  });

  test("a different publisher key does not bind", () => {
    const id = identityFor(seed({ fingerprint: OFFICIAL_FP }), manifest(`${"B".repeat(43)}=`));
    expect(id.indexServiceId).toBe(CODE_ID);
  });
});

describe("listExtensionIdentities", () => {
  test("skips a grant whose manifest is unreadable instead of throwing", () => {
    const db = seed({ fingerprint: OFFICIAL_FP });
    expect(listExtensionIdentities(db, TABLE, () => undefined)).toEqual([]);
    expect(listExtensionIdentities(db, TABLE)).toEqual([]); // nothing on disk
    expect(listExtensionIdentities(db, TABLE, () => manifest())).toHaveLength(1);
  });

  test("skips a grant whose extension row is gone", () => {
    const db = seed({ fingerprint: OFFICIAL_FP });
    dbRun(db, "DELETE FROM extension WHERE id = ?", [EXT_ID]);
    expect(listExtensionIdentities(db, TABLE, () => manifest())).toEqual([]);
  });
});

describe("configured-ness through the credentials resolver", () => {
  test("bound id: the grant's legacy key decides, and the manifest path agrees without a resolver", async () => {
    const db = seed({ fingerprint: OFFICIAL_FP });
    const resolver = createExtensionCredentialsResolver(db, TABLE, () => manifest());
    const vault = createMockVault();
    expect(await isConnectorConfigured(vault, "readwise", resolver)).toBe(false);
    await vault.set("readwise.token", "t");
    expect(await isConnectorConfigured(vault, "readwise", resolver)).toBe(true);
    // The existing manifest check through readwise.token, no resolver.
    expect(await isConnectorConfigured(vault, "readwise")).toBe(true);
    await vault.set("readwise.token", "  ");
    expect(await isConnectorConfigured(vault, "readwise", resolver)).toBe(false);
    expect(await isConnectorConfigured(vault, "readwise")).toBe(false);
  });

  test("unbound ext_ with blank credential is not configured", async () => {
    const db = seed({
      fingerprint: null,
      credentialsJson: JSON.stringify({
        token: { env: "READWISE_TOKEN", vaultKey: `ext.${CODE_ID}.token` },
      }),
    });
    const resolver = createExtensionCredentialsResolver(db, TABLE, () => manifest());
    const vault = createMockVault();
    // Without a resolver this answers true vacuously (an ext_ id has no manifest entry).
    expect(await isConnectorConfigured(vault, CODE_ID)).toBe(true);
    expect(await isConnectorConfigured(vault, CODE_ID, resolver)).toBe(false);
    await vault.set(`ext.${CODE_ID}.token`, "t");
    expect(await isConnectorConfigured(vault, CODE_ID, resolver)).toBe(true);
  });

  test("an id no grant answers to is left to the built-in checks", () => {
    const resolver = createExtensionCredentialsResolver(seed({ fingerprint: null }), TABLE, () =>
      manifest(),
    );
    expect(resolver("github")).toBeUndefined();
  });

  test("a built-in id is answered with no reads at all", () => {
    let reads = 0;
    const resolver = createExtensionCredentialsResolver(seed({ fingerprint: null }), TABLE, () => {
      reads++;
      return manifest();
    });
    expect(resolver("github")).toBeUndefined();
    expect(reads).toBe(0);
    // A bound legacy id and an ext_ id do read.
    resolver("readwise");
    expect(reads).toBe(1);
  });

  test("unparseable stored credentials resolve to nothing", () => {
    const db = seed({ fingerprint: null, credentialsJson: "not json" });
    expect(
      createExtensionCredentialsResolver(db, TABLE, () => manifest())(CODE_ID),
    ).toBeUndefined();
  });
});

describe("org policy names the index id", () => {
  function source(db: Database, allowed: readonly string[]) {
    return createExtensionSlotSource({
      db,
      vault: createMockVault(),
      env: {} as never,
      sandboxDir: "x",
      runtimeReadPaths: () => [],
      isConnectorAllowed: (id) => allowed.includes(id),
      continuityTable: TABLE,
      readManifest: () => manifest(),
      verify: (async () => {
        throw new Error("verifier reached");
      }) as never,
    });
  }

  test("org allowlist naming readwise permits the bound extension's spawn", async () => {
    const src = source(seed({ fingerprint: OFFICIAL_FP }), ["readwise"]);
    expect(src.isAllowed(CODE_ID)).toBe(true);
    // Past the policy check: the (stubbed) verifier is what throws.
    await expect(src.prepareSpawn(CODE_ID)).rejects.toThrow("verifier reached");
  });

  test("org allowlist naming only ext_com_nimbus_readwise does not", async () => {
    const src = source(seed({ fingerprint: OFFICIAL_FP }), [CODE_ID]);
    expect(src.isAllowed(CODE_ID)).toBe(false);
    await expect(src.prepareSpawn(CODE_ID)).rejects.toMatchObject({
      code: "ERR_EXTENSION_RUN_POLICY",
    });
  });

  test("an unbound extension is still governed by its ext_ id", () => {
    const db = seed({ fingerprint: null });
    expect(source(db, [CODE_ID]).isAllowed(CODE_ID)).toBe(true);
    expect(source(db, ["readwise"]).isAllowed(CODE_ID)).toBe(false);
    expect(indexServiceIdForCodeServer(db, CODE_ID, TABLE, () => manifest())).toBe(CODE_ID);
  });
});

describe("createExtensionCredentialsResolver — an ext_ id reads its grant directly", () => {
  test("an unreadable manifest cannot drop an ext_ id to the vacuous 'configured' answer", async () => {
    const db = seed({
      fingerprint: null,
      credentialsJson: JSON.stringify({ token: { env: "T", vaultKey: `ext.${CODE_ID}.token` } }),
    });
    const resolve = createExtensionCredentialsResolver(db, TABLE, () => undefined);
    expect(resolve(CODE_ID)).toEqual({ token: { env: "T", vaultKey: `ext.${CODE_ID}.token` } });
    const vault = createMockVault();
    expect(await isConnectorConfigured(vault, CODE_ID, resolve)).toBe(false);
    await vault.set(`ext.${CODE_ID}.token`, "tok");
    expect(await isConnectorConfigured(vault, CODE_ID, resolve)).toBe(true);
    db.close();
  });
});
