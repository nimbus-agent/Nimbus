/**
 * `bootFederationIntoIpcOpts` over a real loopback wire: a second gateway (A, a box keypair and its
 * own index) pairs with the booted one (B) and calls it, so the closures the boot hands the LAN
 * server (preflight, delegated approval, purge, share receive, the operator-validity guard) run as
 * they do in production. Nothing is mocked but the owner's answers, which the test gives through the
 * same broker singletons the owner's CLI answers.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import { federationConsent } from "../../federation/consent-broker.ts";
import { loadOrCreateFederationIdentity } from "../../federation/federation-identity.ts";
import { buildFederationRuntime } from "../../federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../federation/federation-server.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { preflightConsent } from "../../federation/preflight-consent-broker.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { sendFederatedOverWire } from "../../ipc/lan-client.ts";
import { type BoxKeypair, generateBoxKeypair } from "../../ipc/lan-crypto.ts";
import { generatePairingCode } from "../../ipc/lan-pairing.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import { buildShareFile, type ShareBody, type ShareFile } from "../../share/share-format.ts";
import {
  drainPending,
  insertReceivedShare,
  listReceivedShares,
} from "../../share/share-inbox-store.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import { createLinuxPaths } from "../paths.ts";
import { bootFederationIntoIpcOpts } from "./federation-boot.ts";

type IpcOpts = Parameters<typeof createIpcServer>[0];
type IdentityRef = ReturnType<typeof buildIdentityBoot>;

const peerIdFor = (pub: Uint8Array): string => `peer:${bytesToHex(pub.subarray(0, 8))}`;
const ISSUER = "https://idp.example.com";
const NS = "project:zurich";

let root: string;
let db: Database;
let vault: NimbusVault;
let localIndex: LocalIndex;
let ipcOpts: IpcOpts;
let stops: Array<() => void>;
let savedPort: string | undefined;
let aKp: BoxKeypair;
let bPub: Uint8Array;
let bPort: number;
let holder: { current: IdentityRef | undefined };

const policyGate = {
  enforced: () => ({
    retentionDays: 30,
    retentionMinDays: 0,
    hitlRequired: new Set<string>(),
    quorum: new Map(),
    capabilitiesDisabled: new Set<string>(),
    chatops: { channels: new Map(), ownership: new Map() },
  }),
} as unknown as PolicyGate;

async function bootB(identityEnabled = false): Promise<void> {
  await bootFederationIntoIpcOpts({
    federationCfg: {
      enabled: true,
      consentTimeoutSeconds: 5,
      mdnsEnabled: false,
      mdnsBind: "127.0.0.1",
    },
    paths: { ...createLinuxPaths(), configDir: root, sandboxDir: join(root, "sandbox") },
    vault,
    db,
    localIndex,
    ipcOpts,
    sidecarStops: stops,
    policyGate,
    isConnectorAllowed: () => true,
    identityEnabled,
    identityBootRefHolder: holder,
  });
  bPort = ipcOpts.lanServer?.listenAddr()?.port ?? 0;
}

/** A pairs with B (the production outbound handshake), so B's server knows A as a peer. */
async function pairA(): Promise<string> {
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, CURRENT_SCHEMA_VERSION);
  const runtime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    new LocalIndex(aDb),
    aKp,
  );
  if (runtime === undefined) throw new Error("federation runtime should be enabled");
  const code = generatePairingCode();
  ipcOpts.lanPairingWindow?.open(code);
  await runtime.pairing.initiatePair("127.0.0.1", bPort, code);
  return peerIdFor(aKp.publicKey);
}

function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  return sendFederatedOverWire("127.0.0.1", bPort, aKp, bPub, method, params, 5000, {
    known: 1,
  });
}

function auditTypes(prefix: string): string[] {
  return (
    db
      .query("SELECT action_type FROM audit_log WHERE action_type LIKE ? ORDER BY id")
      .all(`${prefix}%`) as Array<{ action_type: string }>
  ).map((r) => r.action_type);
}

function signedShare(): ShareFile {
  const seed = new Uint8Array(32).fill(7);
  const pubkeyB64 = Buffer.from(nacl.sign.keyPair.fromSeed(seed).publicKey).toString("base64");
  const body: ShareBody = {
    kind: "transcript",
    sessionId: "s1",
    createdAt: Date.now(),
    expiresAt: null,
    redactionSet: [],
    origin: { label: "gateway-a", pubkey: pubkeyB64 },
    turns: [{ role: "user", text: "hello", timestamp: Date.now() }],
    toolCalls: [],
  };
  return buildShareFile(body, Buffer.from(seed).toString("base64"), pubkeyB64);
}

async function until(cond: () => boolean): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 20));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "assemble-fedwire-"));
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  vault = makeInMemoryVault();
  localIndex = new LocalIndex(db);
  ipcOpts = {} as unknown as IpcOpts;
  stops = [];
  holder = { current: undefined };
  aKp = generateBoxKeypair();
  bPub = (await loadOrCreateFederationIdentity(vault)).publicKey;
  savedPort = processEnvGet("NIMBUS_LAN_PORT");
  processEnvSet("NIMBUS_LAN_PORT", "0");
  writeFileSync(join(root, "nimbus.toml"), ["[lan]", 'bind = "127.0.0.1"'].join("\n"));
});

afterEach(async () => {
  for (const s of stops.splice(0).reverse()) s();
  federationConsent.setBroadcast(() => {});
  preflightConsent.setBroadcast(() => {});
  delegatedApprovalBroker.setBroadcast(() => {});
  await new Promise((r) => setTimeout(r, 20));
  processEnvSet("NIMBUS_LAN_PORT", savedPort);
  db.close();
  rmDirWithRetry(root);
});

describe("share receive (inert, signature-checked)", () => {
  test("a validly signed share from a paired peer is stored as an inert received share", async () => {
    await bootB();
    await pairA();
    const share = signedShare();
    expect(await call("federation.shareReceive", { share })).toEqual({ ok: true });
    const inbox = listReceivedShares(db, {});
    expect(inbox).toHaveLength(1);
    expect(inbox[0]?.share.contentHash).toBe(share.contentHash);
  });

  test("a share whose body was altered after signing is refused and nothing is stored", async () => {
    await bootB();
    await pairA();
    const share = signedShare();
    const forged = { ...share, body: { ...share.body, sessionId: "tampered" } };
    expect(await call("federation.shareReceive", { share: forged })).toEqual({
      ok: false,
      reason: "content signature invalid",
    });
    expect(listReceivedShares(db, {})).toEqual([]);
  });
});

describe("delegated approval (I20): this gateway answers an owner's routed request", () => {
  test("the local person's answer through the broker is what the owner gets back, and it is audited", async () => {
    await bootB();
    await pairA();
    const prompts: string[] = [];
    let answer = true;
    delegatedApprovalBroker.setBroadcast((requestId, prompt) => {
      prompts.push(prompt);
      delegatedApprovalBroker.respond(requestId, "peer:local", answer);
    });
    expect(await call("federation.requestApproval", { actionType: "slack.message.post" })).toEqual({
      approved: true,
    });
    answer = false;
    expect(await call("federation.requestApproval", { actionType: "slack.message.post" })).toEqual({
      approved: false,
    });
    expect(prompts).toEqual([
      "Approve delegated action: slack.message.post?",
      "Approve delegated action: slack.message.post?",
    ]);
    expect(auditTypes("hitl.delegate.answered")).toHaveLength(2);
  });
});

describe("GDPR purge (HITL, signed receipt)", () => {
  async function setup(): Promise<{ aPeerId: string; selfPeerId: string }> {
    await bootB();
    const aPeerId = await pairA();
    const ns = new NamespaceStore(db);
    ns.publish("eng", [{ kind: "service", value: "github" }]);
    ns.grant("eng", aPeerId, "viewer", false);
    const identity = await loadOrCreateFederationIdentity(vault);
    return { aPeerId, selfPeerId: `peer:${bytesToHex(identity.publicKey.subarray(0, 8))}` };
  }

  test("an approving owner revokes the asking peer's grants and receives a signed record of the count", async () => {
    const { aPeerId, selfPeerId } = await setup();
    federationConsent.setBroadcast((_m, params) => {
      federationConsent.respond(String((params as { requestId: string }).requestId), true);
    });
    const r = (await call("federation.purge", { externalId: "ext-1" })) as {
      kind: string;
      record: { externalId: string; peerId: string; deletedCount: number };
      sig: string;
    };
    expect(r.kind).toBe("ok");
    expect(r.record).toMatchObject({ externalId: "ext-1", peerId: selfPeerId, deletedCount: 1 });
    expect(r.sig.length).toBeGreaterThan(0);
    expect(new NamespaceStore(db).getActiveGrant("eng", aPeerId)).toBeUndefined();
  });

  test("a denying owner deletes nothing", async () => {
    const { aPeerId } = await setup();
    federationConsent.setBroadcast((_m, params) => {
      federationConsent.respond(String((params as { requestId: string }).requestId), false);
    });
    expect(await call("federation.purge", { externalId: "ext-1" })).toEqual({
      kind: "error",
      error: "purge_denied",
    });
    expect(new NamespaceStore(db).getActiveGrant("eng", aPeerId)).toBeDefined();
  });
});

describe("inbound preflight (I24) and the operator-validity guard (I18)", () => {
  const approvals: Array<Record<string, unknown>> = [];

  async function granted(): Promise<string> {
    await bootB(false);
    const aPeerId = await pairA();
    const ns = new NamespaceStore(db);
    ns.publish(NS, [{ kind: "service", value: "github" }]);
    ns.grant(NS, aPeerId, "viewer", true);
    return aPeerId;
  }
  const ask = (ns = NS) =>
    call("federation.preflight", {
      namespace: ns,
      ref: "HEAD",
      changedSurface: ["a.ts"],
      purpose: "merge",
    });
  const configure = (ns = NS) =>
    writeFileSync(
      join(root, "nimbus.toml"),
      [
        "[lan]",
        'bind = "127.0.0.1"',
        "",
        `[federation.preflight."${ns}"]`,
        'command = "bun"',
        'args = ["--version"]',
      ].join("\n"),
    );

  beforeEach(() => {
    approvals.length = 0;
    preflightConsent.setBroadcast((_m, params) => {
      approvals.push(params as Record<string, unknown>);
      preflightConsent.respond(String((params as { requestId: string }).requestId), false);
    });
  });

  test("a granted namespace with a locally configured command asks the owner, who can decline", async () => {
    await granted();
    configure();
    expect(await ask()).toEqual({ kind: "error", error: "denied" });
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ namespace: NS, ref: "HEAD" });
    expect(auditTypes("federation.preflight")).toEqual(["federation.preflight.denied"]);
  });

  test("a namespace the peer holds no grant on is refused without asking the owner", async () => {
    await granted();
    configure("project:other");
    expect(await ask("project:other")).toEqual({ kind: "error", error: "no_grant" });
    expect(approvals).toEqual([]);
  });

  test("a granted namespace with no local command is not configured, and the caller cannot supply one", async () => {
    await granted();
    expect(await ask()).toEqual({ kind: "error", error: "not_configured" });
    expect(approvals).toEqual([]);
  });

  test("with identity enabled but not yet booted a peer is refused even with a grant, and is served once the operator session is live", async () => {
    await bootB(true);
    const aPeerId = await pairA();
    const ns = new NamespaceStore(db);
    ns.publish(NS, [{ kind: "service", value: "github" }]);
    ns.grant(NS, aPeerId, "viewer", true);
    configure();

    expect(await ask()).toEqual({ kind: "error", error: "no_grant" });
    expect(approvals).toEqual([]);

    // The identity boots after federation did; the guard reads the holder per call.
    const store = new IdentityStore(db);
    store.upsertSession({
      issuer: ISSUER,
      externalId: "ext-1",
      email: null,
      validatedAt: 1,
      expiresAt: Date.now() + 60_000,
      status: "active",
    });
    holder.current = { store, issuer: ISSUER, graceSeconds: 0 } as unknown as IdentityRef;
    expect(await ask()).toEqual({ kind: "error", error: "denied" });
    expect(approvals).toHaveLength(1);

    // And a session that has since expired closes it again.
    store.setSessionStatus(ISSUER, "expired");
    expect(await ask()).toEqual({ kind: "error", error: "no_grant" });
    expect(approvals).toHaveLength(1);
  });
});

describe("draining queued forwards when a peer pairs", () => {
  async function peerC(withReceive: boolean): Promise<{
    cKp: BoxKeypair;
    cPort: number;
    cDb: Database;
    open: (code: string) => void;
    stop: () => void;
  }> {
    const cDb = new Database(":memory:");
    runIndexedSchemaMigrations(cDb, CURRENT_SCHEMA_VERSION);
    const cKp = generateBoxKeypair();
    const built = buildFederationLanServer({
      db: cDb,
      index: new LocalIndex(cDb),
      identity: cKp,
      lan: {
        bind: "127.0.0.1",
        port: 0,
        pairingWindowSeconds: 60,
        maxFailedAttempts: 3,
        lockoutSeconds: 60,
      },
      consentTimeoutMs: 100,
      notify: () => {},
      ...(withReceive
        ? {
            receiveShareDeps: {
              now: () => Date.now(),
              storeReceived: (share: ShareFile) =>
                insertReceivedShare(cDb, { share, now: Date.now() }),
            },
          }
        : {}),
    });
    await built.lanServer.start();
    return {
      cKp,
      cPort: built.lanServer.listenAddr()?.port ?? 0,
      cDb,
      open: (code) => built.pairingWindow.open(code),
      stop: () => void built.lanServer.stop(),
    };
  }

  test("a forward queued for a not-yet-paired recipient is delivered once the pairing completes", async () => {
    await bootB();
    const c = await peerC(true);
    stops.push(c.stop);
    const recipient = Buffer.from(c.cKp.publicKey).toString("base64");
    const share = signedShare();
    ipcOpts.federationForwardShareDeps?.queuePending(recipient, share);

    const code = generatePairingCode();
    c.open(code);
    await ipcOpts.federationPairing?.initiatePair("127.0.0.1", c.cPort, code);
    await until(() => listReceivedShares(c.cDb, {}).length > 0);

    expect(listReceivedShares(c.cDb, {}).map((r) => r.share.contentHash)).toEqual([
      share.contentHash,
    ]);
    // Delivered rows are kept for audit but never drained again.
    await until(() => drainPending(db, recipient).length === 0);
    expect(drainPending(db, recipient)).toEqual([]);
  });

  test("a delivery the recipient refuses stays queued for the next pairing or online event", async () => {
    await bootB();
    const c = await peerC(false); // no receive deps: the recipient answers with an error
    stops.push(c.stop);
    const recipient = Buffer.from(c.cKp.publicKey).toString("base64");
    ipcOpts.federationForwardShareDeps?.queuePending(recipient, signedShare());

    const code = generatePairingCode();
    c.open(code);
    await ipcOpts.federationPairing?.initiatePair("127.0.0.1", c.cPort, code);
    await new Promise((r) => setTimeout(r, 300));
    expect(drainPending(db, recipient)).toHaveLength(1);
  });

  test("an owner-approved forward to a paired peer is delivered over the wire", async () => {
    await bootB();
    const c = await peerC(true);
    stops.push(c.stop);
    const code = generatePairingCode();
    c.open(code);
    await ipcOpts.federationPairing?.initiatePair("127.0.0.1", c.cPort, code);
    const peer = ipcOpts.federationForwardShareDeps?.lookupPeer(
      Buffer.from(c.cKp.publicKey).toString("base64"),
    );
    expect(peer).toMatchObject({ host: "127.0.0.1", port: c.cPort });
    const share = signedShare();
    expect(await ipcOpts.shareDeliverToPeer?.(share, peerIdFor(c.cKp.publicKey))).toBe(true);
    expect(listReceivedShares(c.cDb, {}).map((r) => r.share.contentHash)).toEqual([
      share.contentHash,
    ]);
  });
});
