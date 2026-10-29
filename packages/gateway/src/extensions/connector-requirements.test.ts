import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signTrustStatement } from "@nimbus-dev/registry-format";
import nacl from "tweetnacl";

import { rmDirWithRetry } from "../../test/helpers/rm-dir-with-retry.ts";
import { insertExtensionRow } from "../automation/extension-store.ts";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { dbRun } from "../db/write.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { patConnectorAuthServiceIds } from "../ipc/connector-rpc-handlers/auth.ts";
import { MockVault } from "../vault/mock.ts";
import { connectorRequirementStatuses } from "./connector-requirements.ts";
import type { ContinuityEntry } from "./continuity/continuity-table.ts";
import { resolveRunCredentials, serializeRunCredentials } from "./extension-credentials.ts";
import { upsertRunGrant } from "./run-grant-store.ts";
import { recordTrustStatements } from "./trust/trust-store.ts";
import { encodeBase64 } from "./verify-signature.ts";

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
  dbRun(db, "UPDATE extension SET source_root_fingerprint = ?, tree_digest = ? WHERE id = ?", [
    FP,
    "d",
    EXT,
  ]);
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

  test("a bundled token connector with no key names connector auth with its --token flag", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["github"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual(["nimbus connector auth github --token <token>"]);
    expect(s?.interactive).toBe(false);
  });

  test.each([
    ["jira", "nimbus connector auth jira --username <email> --token <api_token> --api-base <url>"],
    [
      "confluence",
      "nimbus connector auth confluence --username <email> --token <api_token> --api-base <url>",
    ],
    [
      "bitbucket",
      "nimbus connector auth bitbucket --username <atlassian_username> --token <app_password>",
    ],
    ["sentry", "nimbus connector auth sentry --token <token> --sentry-org <slug>"],
    [
      "jenkins",
      "nimbus connector auth jenkins --username <user> --token <api_token> --api-base <url>",
    ],
    ["grafana", "nimbus connector auth grafana --api-base <url> --token <api_token>"],
    ["discord", "nimbus connector auth discord --token <bot_token> --enable"],
    [
      "datadog",
      "nimbus connector auth datadog --datadog-api-key <api_key> --datadog-app-key <app_key>",
    ],
    ["kubernetes", "nimbus connector auth kubernetes --kubeconfig <path>"],
    ["aws", "nimbus connector auth aws --aws-profile <profile>"],
    [
      "azure",
      "nimbus connector auth azure --azure-tenant-id <id> --azure-client-id <id> --azure-client-secret <secret>",
    ],
    ["gcp", "nimbus connector auth gcp --gcp-credentials-json <path>"],
    ["iac", "nimbus connector auth iac --enable"],
  ])("%s's fix names every flag connector auth requires", async (id, command) => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one([id]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([command]);
  });

  /**
   * The connectors whose `nimbus connector auth` needs `--token` and nothing else. The source of
   * truth is the CLI, `packages/cli/src/commands/connector.ts` (each `apply*ConnectorAuth`): a
   * connector belongs here only when its CLI auth succeeds with `--token` alone.
   */
  const TOKEN_ONLY_CLI_AUTH = ["github", "gitlab", "linear", "circleci", "pagerduty", "newrelic"];

  test("every connector auth token connector beyond the token-only ones names its own flags", async () => {
    const ids = patConnectorAuthServiceIds();
    expect(ids).toEqual(expect.arrayContaining(TOKEN_ONLY_CLI_AUTH));
    for (const id of ids) {
      const [s] = await connectorRequirementStatuses({ db, vault }, one([id]));
      const fallback = `nimbus connector auth ${id} --token <token>`;
      if (TOKEN_ONLY_CLI_AUTH.includes(id)) {
        expect({ id, fix: s?.fix }).toEqual({ id, fix: [fallback] });
      } else {
        expect({ id, fix: s?.fix }).not.toEqual({ id, fix: [fallback] });
        expect(s?.fix[0]?.startsWith(`nimbus connector auth ${id} `)).toBe(true);
      }
    }
  });

  test("an OAuth connector with no key names plain connector auth", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["gmail"]));
    expect(s?.fix).toEqual(["nimbus connector auth gmail"]);
    expect(s?.interactive).toBe(true);
  });

  test("a connector that connector auth refuses names one vault set per manifest key", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["snowflake"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual(
      CONNECTOR_VAULT_SECRET_KEYS.snowflake.map((k) => `nimbus vault set ${k}`),
    );
    expect(s?.fix.length).toBeGreaterThan(0);
    expect(s?.interactive).toBe(false);
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
    expect(before[0]?.fix).toEqual(
      CONNECTOR_VAULT_SECRET_KEYS.great_expectations.map((k) => `nimbus vault set ${k}`),
    );

    await vault.set(firstKey("great_expectations"), "/results");
    synced("great_expectations");
    const after = await connectorRequirementStatuses({ db, vault }, one(["great-expectations"]));
    expect(after[0]?.connector).toBe("great-expectations");
    expect(after[0]?.state).toBe("met");
  });

  test("a reused credential points at its source service", async () => {
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["github_actions"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual(["nimbus connector auth github --token <token>"]);
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

  test("an installed owner with an unreadable manifest binds nothing and is unknown, never bundled", async () => {
    installOwner({ readable: false });
    await vault.set(firstKey("github"), "ghp_x");
    synced("github");
    const out = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx", "github"]),
    );
    expect(out.map((s) => [s.connector, s.state, s.owner, s.fix])).toEqual([
      ["github", "met", { kind: "bundled" }, []],
      ["legacyx", "unknown", { kind: "extension", extensionId: EXT }, []],
    ]);
  });

  test("owner without grant", async () => {
    installOwner();
    // Both credentials the approval WILL grant are stored: only the approval is missing.
    await vault.set("legacyx.token", "legacy-value");
    await vault.set(OWN_API_KEY, "own-value");
    synced("legacyx");
    expect(
      await connectorRequirementStatuses({ db, vault, continuityTable: TABLE }, one(["legacyx"])),
    ).toEqual([
      {
        connector: "legacyx",
        state: "not_connected",
        owner: { kind: "extension", extensionId: EXT },
        fix: [`nimbus extension approve ${EXT}`],
        interactive: true,
        requiredBy: ["com.a"],
      },
    ]);
  });

  test("owner without grant names only the blank credentials the approval will grant", async () => {
    installOwner();
    // The legacy key the binding maps is stored; the declared name it does not map is not.
    await vault.set("legacyx.token", "legacy-value");
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.fix).toEqual([
      `nimbus extension approve ${EXT}`,
      `nimbus extension credential set ${EXT} api_key`,
    ]);
  });

  test("a trust-blocked owner is never met and names extension info", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    await vault.set(OWN_API_KEY, "set");
    synced("legacyx");
    const deps = { db, vault, continuityTable: TABLE };
    expect((await connectorRequirementStatuses(deps, one(["legacyx"])))[0]?.state).toBe("met");

    const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 5);
    const nimbusKey = encodeBase64(nacl.sign.keyPair.fromSeed(seed).publicKey);
    const takedown = await signTrustStatement(
      {
        kind: "extension.takedown",
        issuedAt: "2026-10-26T12:00:00Z",
        signerKey: nimbusKey,
        extensionId: EXT,
        publisherId: "test-pub",
        versions: "*",
        reason: "malware",
      },
      seed,
    );
    recordTrustStatements(db, [takedown], { kind: "feed", nimbusRootKey: nimbusKey }, 1);
    const [s] = await connectorRequirementStatuses(deps, one(["legacyx"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([`nimbus extension info ${EXT}`]);
    expect(s?.interactive).toBe(false);
  });

  test("a disabled owner is not connected and names extension enable", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    await vault.set(OWN_API_KEY, "set");
    synced("legacyx");
    dbRun(db, "UPDATE extension SET enabled = 0 WHERE id = ?", [EXT]);
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([`nimbus extension enable ${EXT}`]);
    expect(s?.interactive).toBe(false);
  });

  test("a grant for other code is stale: never met, the fix re-approves first", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    synced("legacyx");
    dbRun(db, "UPDATE extension SET tree_digest = ? WHERE id = ?", ["other", EXT]);
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([
      `nimbus extension approve ${EXT}`,
      `nimbus extension credential set ${EXT} api_key`,
    ]);
  });

  test("a stale grant with every credential stored still re-approves", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    await vault.set(OWN_API_KEY, "set");
    synced("legacyx");
    dbRun(db, "UPDATE extension SET version = ? WHERE id = ?", ["1.0.1", EXT]);
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([`nimbus extension approve ${EXT}`]);
  });

  test("a bound id whose owner is not installed names extension install, never the bundled path", async () => {
    // `legacyx` is not a catalog id: on the bundled path it would read unknown_connector.
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s).toEqual({
      connector: "legacyx",
      state: "not_connected",
      owner: { kind: "extension", extensionId: EXT },
      fix: [`nimbus extension install ${EXT}`],
      interactive: false,
      requiredBy: ["com.a"],
    });
  });

  test("the real table: readwise with its key set but no extension installed is never met", async () => {
    // audit-ignore-next-line D11-vault-key (the legacy readwise key, set as a fixture)
    await vault.set("readwise.token", "set");
    synced("readwise");
    const [s] = await connectorRequirementStatuses({ db, vault }, one(["readwise"]));
    expect(s?.state).toBe("not_connected");
    expect(s?.owner).toEqual({ kind: "extension", extensionId: "com.nimbus.readwise" });
    expect(s?.fix).toEqual(["nimbus extension install com.nimbus.readwise"]);
  });

  test("an unbundled id with no continuity entry is unknown_connector", async () => {
    // audit-ignore-next-line D11-vault-key (the legacy readwise key, set as a fixture)
    await vault.set("readwise.token", "set");
    synced("readwise");
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: [] },
      one(["readwise"]),
    );
    expect(s?.state).toBe("unknown_connector");
    expect(s?.fix).toEqual([]);
  });

  test("each of an owner's credentials is read from the Vault once, blank ones included", async () => {
    installOwner();
    grantOwner();
    await vault.set("legacyx.token", "set");
    synced("legacyx");
    const reads: string[] = [];
    const realGet = vault.get.bind(vault);
    vault.get = async (key: string) => {
      reads.push(key);
      return realGet(key);
    };
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.state).toBe("not_connected");
    expect(reads.sort()).toEqual([OWN_API_KEY, "legacyx.token"].sort());
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

describe("connectorRequirementStatuses — a starter pack as a bound owner", () => {
  test("a pack row the continuity table binds is not_connected with no fix, never `extension approve`", async () => {
    // Hand-built: no shipped continuity entry names a pack. Bound through the test entry anyway.
    const dir = join(tmp, "pack");
    mkdirSync(dir, { recursive: true });
    const bytes = JSON.stringify({
      id: EXT,
      version: "1.0.0",
      kind: "starter-pack",
      publisher: { id: "test-pub", key: KEY },
      signature: `${"A".repeat(86)}==`,
      requires: { connectors: ["github"] },
    });
    writeFileSync(join(dir, "nimbus.extension.json"), bytes);
    insertExtensionRow(db, {
      id: EXT,
      version: "1.0.0",
      install_path: dir,
      manifest_hash: createHash("sha256").update(bytes).digest("hex"),
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
      kind: "starter-pack",
    });
    dbRun(db, "UPDATE extension SET source_root_fingerprint = ?, tree_digest = ? WHERE id = ?", [
      FP,
      "d",
      EXT,
    ]);
    const [s] = await connectorRequirementStatuses(
      { db, vault, continuityTable: TABLE },
      one(["legacyx"]),
    );
    expect(s?.owner).toEqual({ kind: "extension", extensionId: EXT });
    expect(s?.state).toBe("not_connected");
    expect(s?.fix).toEqual([]);
    expect(s?.interactive).toBe(false);
  });
});
