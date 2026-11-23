import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { loadNimbusAuditFromConfigDir } from "../../config/nimbus-toml.ts";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { POLICY_SIGNING_PUBKEY } from "../../policy/anchor-keypair.ts";
import { authorPolicy } from "../../policy/policy-author.ts";
import { buildPolicyGate } from "../../policy/policy-gate.ts";
import { PolicyStore } from "../../policy/policy-store.ts";
import { encodeBase64 } from "../../util/base64.ts";
import { generateEd25519Keypair } from "../../util/ed25519.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";
import {
  bootIdentityIntoIpcOpts,
  bootPolicyGateWithConnectorAllowlist,
  buildPolicyRpcCtx,
  CHATOPS_LOCAL_CONSENT_TIMEOUT_MS,
} from "./policy-identity-boot.ts";

type IpcOpts = Parameters<typeof createIpcServer>[0];

const ALLOW_GITHUB_ONLY = `[policy]
version = 3
org = "acme"

[policy.retention]
min_days = 365

[policy.connectors]
allow = ["github"]
`;

let root: string;
let db: Database;
let vault: NimbusVault;
let warnings: string[];

const syncLogger = {
  warn: (m: unknown) => {
    warnings.push(String(m));
  },
} as unknown as Logger;

function writeConfig(toml: string): void {
  writeFileSync(join(root, "nimbus.toml"), toml);
}

/** Persist a signed policy the way an anchor does, through a throwaway gate on the same database. */
function storeAnchorPolicy(toml: string): void {
  const store = new PolicyStore(db);
  const gate = buildPolicyGate(db, store, {
    retentionDays: 7,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set<string>(),
  });
  const kp = generateEd25519Keypair();
  const r = authorPolicy(
    {
      store,
      gate,
      db,
      privkeyB64: encodeBase64(kp.privkey),
      pubkeyB64: encodeBase64(kp.pubkey),
      nowMs: 1_700_000_000_000,
    },
    toml,
  );
  if (!r.ok) throw new Error(r.error);
}

function auditCount(actionType: string): number {
  return (
    db.query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = ?").get(actionType) as {
      n: number;
    }
  ).n;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "assemble-policy-"));
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = makeInMemoryVault();
  warnings = [];
});

afterEach(() => {
  db.close();
  rmDirWithRetry(root);
});

test("the ChatOps local-owner fallback waits ten minutes", () => {
  expect(CHATOPS_LOCAL_CONSENT_TIMEOUT_MS).toBe(600_000);
});

describe("bootPolicyGateWithConnectorAllowlist (I22)", () => {
  test("with no org policy nothing is blocked and no connector is audited", () => {
    const auditCfg = loadNimbusAuditFromConfigDir(root);
    const boot = bootPolicyGateWithConnectorAllowlist(db, root, auditCfg);
    expect(boot.policyGate.status().signatureValid).toBe(false);
    expect(boot.isConnectorAllowed("github")).toBe(true);
    expect(boot.isConnectorAllowed("slack")).toBe(true);
    expect(auditCount("policy.connector.blocked")).toBe(0);
    // The local baseline is enforced verbatim when ungoverned.
    expect(boot.policyGate.enforced().retentionDays).toBe(auditCfg.toolCallLogRetentionDays);
  });

  test("a stored policy's allowlist blocks every other connector, audits each, and tightens retention", () => {
    storeAnchorPolicy(ALLOW_GITHUB_ONLY);
    const boot = bootPolicyGateWithConnectorAllowlist(db, root, loadNimbusAuditFromConfigDir(root));
    expect(boot.policyGate.status()).toMatchObject({ org: "acme", signatureValid: true });
    expect(boot.isConnectorAllowed("github")).toBe(true);
    expect(boot.isConnectorAllowed("slack")).toBe(false);
    expect(boot.policyGate.enforced().retentionDays).toBe(365);

    expect(auditCount("policy.connector.blocked")).toBe(
      CONNECTOR_SERVICE_IDS.filter((id) => id !== "github").length,
    );
    const rows = db
      .query("SELECT action_json FROM audit_log WHERE action_type = 'policy.connector.blocked'")
      .all() as Array<{ action_json: string }>;
    const blocked = rows.map((r) => (JSON.parse(r.action_json) as { connector: string }).connector);
    expect(blocked).toContain("slack");
    expect(blocked).not.toContain("github");
  });

  test("the predicate reads the live policy, not the boot-time allowlist", () => {
    const boot = bootPolicyGateWithConnectorAllowlist(db, root, loadNimbusAuditFromConfigDir(root));
    expect(boot.isConnectorAllowed("slack")).toBe(true);
    // A policy applied after boot (an anchor sign or a refetch) takes effect with no restart.
    const kp = generateEd25519Keypair();
    const r = authorPolicy(
      {
        store: boot.policyStore,
        gate: boot.policyGate,
        db,
        privkeyB64: encodeBase64(kp.privkey),
        pubkeyB64: encodeBase64(kp.pubkey),
        nowMs: 1_700_000_000_000,
      },
      ALLOW_GITHUB_ONLY,
    );
    expect(r.ok).toBe(true);
    expect(boot.isConnectorAllowed("slack")).toBe(false);
    expect(boot.isConnectorAllowed("github")).toBe(true);
  });

  test("the local [hitl.quorum] baseline is handed to the gate", () => {
    writeConfig(
      ['[hitl.quorum."slack.message.post"]', "approvers = 2", "window_seconds = 120"].join("\n"),
    );
    const boot = bootPolicyGateWithConnectorAllowlist(db, root, loadNimbusAuditFromConfigDir(root));
    expect(boot.policyGate.enforced().quorum.get("slack.message.post")).toEqual({
      approvers: 2,
      windowSeconds: 120,
    });
  });
});

describe("bootIdentityIntoIpcOpts", () => {
  function freshOpts(): { ipcOpts: IpcOpts; httpOpts: HttpSidecarOpts } {
    return { ipcOpts: {} as unknown as IpcOpts, httpOpts: {} };
  }
  const IDENTITY = [
    "[identity]",
    "enabled = true",
    'issuer = "https://acme.okta.com"',
    'client_id = "0oaABC"',
    "session_grace_seconds = 120",
  ];

  test("identity disabled: returns undefined and wires nothing", () => {
    const { ipcOpts, httpOpts } = freshOpts();
    const boot = bootIdentityIntoIpcOpts({
      configDir: root,
      localIndex: new LocalIndex(db),
      vault,
      syncLogger,
      ipcOpts,
      httpSidecarOpts: httpOpts,
    });
    expect(boot).toBeUndefined();
    expect(Object.keys(ipcOpts)).toEqual([]);
    expect(httpOpts.resolveScimToken).toBeUndefined();
  });

  test("identity enabled: the store, issuer, grace, login and vault reach the IPC options", () => {
    writeConfig(IDENTITY.join("\n"));
    const { ipcOpts, httpOpts } = freshOpts();
    const boot = bootIdentityIntoIpcOpts({
      configDir: root,
      localIndex: new LocalIndex(db),
      vault,
      syncLogger,
      ipcOpts,
      httpSidecarOpts: httpOpts,
    });
    expect(boot).toBeDefined();
    expect(ipcOpts.identityStore).toBe(boot?.store as IdentityStore);
    expect(ipcOpts.identityIssuer).toBe("https://acme.okta.com");
    expect(ipcOpts.identityGraceSeconds).toBe(120);
    expect(ipcOpts.identityStartLogin).toBe(boot?.startLogin as () => { jobId: string });
    expect(ipcOpts.identityVault).toBe(vault);
    // SCIM is a separate switch: off, so the HTTP sidecar gets no bearer resolver.
    expect(httpOpts.resolveScimToken).toBeUndefined();
  });

  test("identity and SCIM enabled: the SCIM bearer resolver reaches the HTTP sidecar", () => {
    writeConfig([...IDENTITY, "", "[scim]", "enabled = true"].join("\n"));
    const { ipcOpts, httpOpts } = freshOpts();
    const boot = bootIdentityIntoIpcOpts({
      configDir: root,
      localIndex: new LocalIndex(db),
      vault,
      syncLogger,
      ipcOpts,
      httpSidecarOpts: httpOpts,
    });
    expect(httpOpts.resolveScimToken).toBe(boot?.resolveScimToken as () => Promise<string>);
  });

  test("SCIM enabled without identity wires nothing (SCIM authenticates through identity)", () => {
    writeConfig(["[scim]", "enabled = true"].join("\n"));
    const { ipcOpts, httpOpts } = freshOpts();
    expect(
      bootIdentityIntoIpcOpts({
        configDir: root,
        localIndex: new LocalIndex(db),
        vault,
        syncLogger,
        ipcOpts,
        httpSidecarOpts: httpOpts,
      }),
    ).toBeUndefined();
    expect(httpOpts.resolveScimToken).toBeUndefined();
  });
});

describe("buildPolicyRpcCtx", () => {
  function ctxFor(identityBoot?: ReturnType<typeof bootIdentityBootStub>) {
    const boot = bootPolicyGateWithConnectorAllowlist(db, root, loadNimbusAuditFromConfigDir(root));
    const localIndex = new LocalIndex(db);
    const ctx = buildPolicyRpcCtx({
      db,
      vault,
      localIndex,
      policyStore: boot.policyStore,
      policyGate: boot.policyGate,
      identityBoot: identityBoot as never,
    });
    return { ctx, boot, localIndex };
  }

  /** The one field the purge reads off a booted identity: its binding store. */
  function bootIdentityBootStub(store: IdentityStore) {
    return { store };
  }

  test("a local call is the anchor, and show reports the gate's own state", () => {
    const { ctx, boot } = ctxFor();
    expect(ctx.isAnchor).toBe(true);
    expect(ctx.showPolicy()).toBe(boot.policyGate.status());
  });

  test("trustPubkey pins a 32-byte key and rejects anything else", () => {
    const { ctx, boot } = ctxFor();
    const pub = encodeBase64(generateEd25519Keypair().pubkey);
    ctx.trustPubkey({ pubkey: pub });
    expect(boot.policyStore.getAnchorPubkey()).toBe(pub);
    expect(() => ctx.trustPubkey({ pubkey: encodeBase64(new Uint8Array(8)) })).toThrow(
      "must be 32 bytes",
    );
  });

  test("refetch with no served bundle reports no_bundle and changes nothing", async () => {
    const { ctx } = ctxFor();
    expect(await ctx.refetch()).toMatchObject({ applied: false, reason: "no_bundle" });
  });

  test("refetch re-verifies the locally served bundle against the pinned anchor key", async () => {
    storeAnchorPolicy(ALLOW_GITHUB_ONLY);
    const { ctx, boot } = ctxFor();
    expect(await ctx.refetch()).toMatchObject({ applied: true });
    expect(boot.policyGate.status().signatureValid).toBe(true);
  });

  test("refetch refuses a bundle that does not verify against the pinned key (fail closed)", async () => {
    storeAnchorPolicy(ALLOW_GITHUB_ONLY);
    const { ctx, boot } = ctxFor();
    boot.policyStore.pinAnchorPubkey(encodeBase64(generateEd25519Keypair().pubkey), "manual", 1);
    expect(await ctx.refetch()).toMatchObject({ applied: false, reason: "bad_signature" });
    // The last valid policy stays in force.
    expect(boot.policyGate.status().signatureValid).toBe(true);
  });

  test("signPolicy creates the Vault-held anchor keypair, applies the policy, and returns org and version", async () => {
    const { ctx, boot } = ctxFor();
    const r = await ctx.signPolicy({ toml: ALLOW_GITHUB_ONLY });
    expect(r).toEqual({ org: "acme", version: 3 });
    expect(await vault.get(POLICY_SIGNING_PUBKEY)).toBe(boot.policyStore.getAnchorPubkey() ?? null);
    expect(boot.policyGate.enforced().connectorAllow).toEqual(["github"]);
  });

  test("signPolicy surfaces an invalid policy as an error and applies nothing", async () => {
    const { ctx, boot } = ctxFor();
    await expect(ctx.signPolicy({ toml: `[policy]\nversion = 0\norg = "acme"\n` })).rejects.toThrow(
      "version",
    );
    expect(boot.policyStore.load()).toBeUndefined();
  });

  test("purge without a bound identity fails closed", () => {
    const { ctx } = ctxFor();
    expect(() => ctx.purge({ externalId: "ext-1" })).toThrow("unknown user ext-1");
  });

  test("purge revokes the bound peer's grants, opens a job for every paired peer, and numbers jobs", async () => {
    const store = new IdentityStore(db);
    store.bind("ext-1", "peer:bound", "admin", 1);
    const ns = new NamespaceStore(db);
    ns.publish("eng", [{ kind: "service", value: "github" }]);
    ns.grant("eng", "peer:bound", "viewer", false);
    const { ctx, localIndex } = ctxFor(bootIdentityBootStub(store));
    localIndex.addLanPeer({
      peerId: "peer:paired",
      peerPubkey: new Uint8Array(32).fill(7),
      direction: "outbound",
    });

    const first = (await ctx.purge({ externalId: "ext-1" })) as {
      jobId: string;
      localDeleted: number;
    };
    expect(first.localDeleted).toBe(1);
    expect(first.jobId).toMatch(/^gdpr-\d+-1$/);
    expect(ns.getActiveGrant("eng", "peer:bound")).toBeUndefined();
    const pending = db
      .query("SELECT peer_id FROM gdpr_purge_request WHERE job_id = ?")
      .all(first.jobId) as Array<{ peer_id: string }>;
    expect(pending.map((r) => r.peer_id)).toEqual(["peer:paired"]);

    const second = (await ctx.purge({ externalId: "ext-1" })) as { jobId: string };
    expect(second.jobId).toMatch(/^gdpr-\d+-2$/);
  });

  test("purge for a user with no active binding fails closed even with an identity store", () => {
    const { ctx } = ctxFor(bootIdentityBootStub(new IdentityStore(db)));
    expect(() => ctx.purge({ externalId: "nobody" })).toThrow("unknown user nobody");
  });
});
