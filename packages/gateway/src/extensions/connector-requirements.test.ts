import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { dbRun } from "../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { MockVault } from "../vault/mock.ts";
import { connectorRequirementStatuses } from "./connector-requirements.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { resolveRunCredentials, serializeRunCredentials } from "./extension-credentials.ts";
import { upsertRunGrant } from "./run-grant-store.ts";

const KEY = `${"A".repeat(43)}=`;
const FP = "fp-test-root";
const EXT = "com.test.legacyx";
const LEGACYX: ContinuityEntry = {
  legacyServiceId: "legacyx",
  extensionId: EXT,
  publisherKey: KEY,
  sourceRootFingerprint: FP,
  // audit-ignore-next-line D11-vault-key (test continuity entry's legacy key)
  credentials: { token: "legacyx.token" },
  expectedPermissions: { network: [], read: [], write: [] },
  itemTypes: [],
};
const TABLE = [LEGACYX];

let db: Database;
let vault: MockVault;
let tmp: string;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = new MockVault();
  tmp = mkdtempSync(join(tmpdir(), "nimbus-conn-req-"));
});

afterEach(() => {
  db.close();
  rmDirWithRetry(tmp);
});

function firstKey(id: keyof typeof CONNECTOR_VAULT_SECRET_KEYS): string {
  const k = CONNECTOR_VAULT_SECRET_KEYS[id][0];
  if (k === undefined) throw new Error(`${id} has no vault key`);
  return k;
}

function synced(id: string): void {
  dbRun(db, "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?)", [id, 1_000]);
}

const CODE_ID = "ext_com_test_legacyx";
/** `token` is mapped by the binding (legacy key); `api_key` is not, so it gets the extension's own key. */
const DECLARED = { token: { env: "LEGACYX_TOKEN" }, api_key: { env: "LEGACYX_API_KEY" } };
// audit-ignore-next-line D11-vault-key (the extension's own key the real writer derives)
const OWN_API_KEY = "ext.ext_com_test_legacyx.api_key";

/** Installs a row for `EXT` whose on-disk manifest is readable (or not) and binds `LEGACYX`. */
function installOwner(opts: { readable?: boolean } = {}): void {
  const dir = join(tmp, "ext");
  mkdirSync(dir, { recursive: true });
  const bytes = JSON.stringify({
    id: EXT,
    version: "1.0.0",
    entry: "dist/index.js",
    publisher: { id: "test-pub", key: KEY },
    // Shape only: reading the installed manifest checks its hash, not its signature.
    signature: `${"A".repeat(86)}==`,
    credentials: DECLARED,
  });
  if (opts.readable !== false) writeFileSync(join(dir, "nimbus.extension.json"), bytes);
  insertExtensionRow(db, {
    id: EXT,
    version: "1.0.0",
    install_path: dir,
    manifest_hash: createHash("sha256").update(bytes).digest("hex"),
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
  dbRun(db, "UPDATE extension SET source_root_fingerprint = ? WHERE id = ?", [FP, EXT]);
}

/** A run grant whose credentials come from the real writer, unless `credentialsJson` overrides them. */
function grantOwner(credentialsJson?: string): void {
  upsertRunGrant(db, {
    extension_id: EXT,
    service_id: CODE_ID,
    version: "1.0.0",
    tree_digest: "d",
    permissions_json: "{}",
    model_access: 0,
    approved_at: 1,
    credentials_json:
      credentialsJson ??
      serializeRunCredentials(resolveRunCredentials({ credentials: DECLARED }, CODE_ID, LEGACYX)),
  });
}

const one = (connectors: string[], extensionId = "com.a") => [{ extensionId, connectors }];

describe("connectorRequirementStatuses", () => {
  test("a bundled connector with its key set and a sync is met", async () => {
    await vault.set(firstKey("github"), "ghp_x");
    synced("github");
    expect(await connectorRequirementStatuses({ db, vault }, one(["github"]))).toEqual([
      {
        connector: "github",
        state: "met",
        owner: { kind: "bundled" },
        fix: [],
        interactive: false,
        requiredBy: ["com.a"],
      },
    ]);
  });

  test("a bundled connector with no key is not connected and names connector auth", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["github"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual(["nimbus connector auth github"]);
  });

  test("configured but never synced is a warning with the sync command", async () => {
    await vault.set(firstKey("github"), "ghp_x");
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["github"]));
    expect(s?.state).toBe("configured_never_synced");
    expect(s?.fix).toEqual(["nimbus connector sync github"]);
  });

  test("an id the gateway does not know is unknown, never met", async () => {
    synced("not_a_connector");
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["not-a-connector"]));
    expect(s?.connector).toBe("not-a-connector");
    expect(s?.state).toBe("unknown_connector");
    expect(s?.fix).toEqual([]);
  });

  test("hyphenated id resolves and keeps the manifest spelling", async () => {
    const before = await connectorRequirementStatuses({ db, vault }, one(["great-expectations"]));
    expect(before[0]?.connector).toBe("great-expectations");
    expect(before[0]?.state).toBe("not_connected");
    expect(before[0]?.fix).toEqual(["nimbus connector auth great_expectations"]);

    await vault.set(firstKey("great_expectations"), "/results");
    synced("great_expectations");
    const after = await connectorRequirementStatuses({ db, vault }, one(["great-expectations"]));
    expect(after[0]?.connector).toBe("great-expectations");
    expect(after[0]?.state).toBe("met");
  });

  test("a reused credential points at its source service", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["github_actions"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual(["nimbus connector auth github"]);
  });

  test("OAuth connectors are interactive, token connectors are not", async () => {
    const out = await connectorRequirementStatuses({ db, vault }, one(["gmail", "github"]));
    expect(out.map((s) => [s.connector, s.interactive])).toEqual([
      ["github", false],
      ["gmail", true],
    ]);
  });

  test("an owner with a grant is judged by every credential the grant names, and the fix names only the blank ones", async () => {
    installOwner();
    grantOwner();
    // The bound legacy key is set; the declared credential the binding does not map is blank.
    await vault.set("legacyx.token", "set");
    synced("legacyx");
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.owner).toEqual({ kind: "extension", extensionId: EXT });
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([`nimbus extension credential set ${EXT} api_key`]);
    expect(s?.interactive).toBe(true);
  });

  test("a grant whose credentials do not parse is unknown and keeps its extension owner", async () => {
    installOwner();
    grantOwner("not json");
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.state).toBe("unknown");
    expect(s?.owner).toEqual({ kind: "extension", extensionId: EXT });
    expect(s?.fix).toEqual([]);
  });

  test("an owner with a grant and its credential set is met once synced", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    await vault.set(OWN_API_KEY, "set");
    const deps = { db, vault, continuityTable: TABLE };
    expect((await connectorRequirementStatuses(deps, one(["legacyx"])))[0]?.state).toBe(
      "configured_never_synced",
    );
    synced("legacyx");
    expect((await connectorRequirementStatuses(deps, one(["legacyx"])))[0]?.state).toBe("met");
  });

  test("an installed row with an unreadable manifest is skipped", async () => {
    installOwner({ readable: false });
    await vault.set(firstKey("github"), "ghp_x");
    synced("github");
    const out = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx", "github"]),
    );
    expect(out.map((s) => [s.connector, s.state, s.owner.kind])).toEqual([
      ["github", "met", "bundled"],
      ["legacyx", "unknown_connector", "bundled"],
    ]);
  });

  test("owner without grant", async () => {
    installOwner();
    await vault.set("legacyx.token", "legacy-value");
    synced("legacyx");
    expect(
      await connectorRequirementStatuses({ db, vault, continuityTable: TABLE }, one(["legacyx"])),
    ).toEqual([
      {
        connector: "legacyx",
        state: "not_connected",
        owner: { kind: "extension", extensionId: EXT },
        fix: [`nimbus extension approve ${EXT}`, `nimbus extension credential set ${EXT} token`],
        interactive: true,
        requiredBy: ["com.a"],
      },
    ]);
  });

  test("two extensions requiring one connector are merged", async () => {
    const out = await connectorRequirementStatuses({ db, vault }, [
      { extensionId: "com.z", connectors: ["github"] },
      { extensionId: "com.b", connectors: ["github", "gmail"] },
      { extensionId: "com.m", connectors: ["github"] },
    ]);
    expect(out.map((s) => [s.connector, s.requiredBy])).toEqual([
      ["github", ["com.b", "com.m", "com.z"]],
      ["gmail", ["com.b"]],
    ]);
  });

  test("a vault read that throws yields unknown for that connector only", async () => {
    const realGet = vault.get.bind(vault);
    vault.get = async (key: string) => {
      if (key === firstKey("github")) throw new Error("vault locked");
      return realGet(key);
    };
    await vault.set(firstKey("gitlab"), "glpat_x");
    synced("gitlab");
    const out = await connectorRequirementStatuses({ db, vault }, one(["github", "gitlab"]));
    expect(out.map((s) => [s.connector, s.state, s.fix])).toEqual([
      ["github", "unknown", []],
      ["gitlab", "met", []],
    ]);
  });
});
