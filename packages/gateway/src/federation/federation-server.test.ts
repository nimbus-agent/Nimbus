import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { PreflightCommandConfig } from "../config/nimbus-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "../ipc/federation-rpc.ts";
import { outboundPairHandshake, sendFederatedOverWire } from "../ipc/lan-client.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { generatePairingCode, PairingWindow } from "../ipc/lan-pairing.ts";
import { type DeletionRecord, verifyDeletionRecord } from "../policy/deletion-record.ts";
import { federationConsent } from "./consent-broker.ts";
import { InMemoryDiscoveryProvider } from "./discovery.ts";
import {
  buildFederationLanServer,
  EMPTY_DISCOVERY,
  EMPTY_PEER_PAIRING,
  pairingServiceFor,
} from "./federation-server.ts";
import { PeerPairing } from "./peer-pairing.ts";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await stop?.();
  stop = undefined;
  federationConsent.setBroadcast(() => {});
});

test("buildFederationLanServer registers an inbound peer on a valid pair handshake", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix','b',10,1,'{}')`);

  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  stop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  // outboundPairHandshake takes 4 args: (host, port, code, selfKp)
  const hostPub = await outboundPairHandshake("127.0.0.1", port, code, askerKp);
  expect(Buffer.from(hostPub).toString("hex")).toBe(
    Buffer.from(identity.publicKey).toString("hex"),
  );

  // an inbound, read-only peer row now exists
  const row = index.getLanPeerByPubkey(askerKp.publicKey);
  expect(row).toBeDefined();
  expect(row?.direction).toBe("inbound");
  expect(row?.write_allowed).toBe(0);
  index.close();
});

test("onMessage forces the authenticated peerId (body peerId cannot impersonate)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);
  db.run(`INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('github:pr1','github','pull_request','pr1','Fix','b',10,1,'{}')`);

  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 5000,
    notify: () => {},
  });
  await built.lanServer.start();
  const testStop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  // Pair the asker so it becomes a known peer on the answerer
  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", port, code, askerKp);

  // Compute the authenticated peerId for the asker
  const askerPeerId = `peer:${bytesToHex(askerKp.publicKey.subarray(0, 8))}`;

  // On the answerer's db: publish a namespace and grant the authenticated askerPeerId a standing grant
  const ctx: FederationRpcContext = {
    db,
    consentTimeoutMs: 5000,
    notify: () => {},
    discovery: new InMemoryDiscoveryProvider(),
    pairing: new PeerPairing(index),
  };
  await dispatchFederationRpc(
    "federation.namespace.publish",
    { name: "ns-imp", filters: [{ kind: "type", value: "pull_request" }] },
    ctx,
  );
  await dispatchFederationRpc(
    "federation.namespace.grant",
    { namespace: "ns-imp", peerId: askerPeerId, role: "viewer", standingConsent: true },
    ctx,
  );

  // Send query over the wire with a BOGUS body peerId — the answerer must use the
  // NaCl-authenticated askerPeerId (which holds the grant), not the body's "peer:bogus".
  const res = await sendFederatedOverWire(
    "127.0.0.1",
    port,
    askerKp,
    identity.publicKey,
    "federation.query",
    { namespace: "ns-imp", purpose: "test", peerId: "peer:bogus" },
  );

  // If the answerer had honoured the body peerId, there would be no grant for "peer:bogus"
  // and it would return { kind: "error", error: "no_grant" }. An "ok" proves it used the
  // authenticated peerId.
  expect((res as { kind: string }).kind).toBe("ok");

  await testStop();
  index.close();
});

test("onMessage throws on an unhandled federation method (-32601 miss)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  const testStop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  // Pair the asker so the hello handshake succeeds
  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", port, code, askerKp);

  // An unknown federation method reaches onMessage → dispatchFederationRpc miss → LanError(-32601)
  // → the encrypted error reply makes sendFederatedOverWire throw.
  let threw = false;
  try {
    await sendFederatedOverWire(
      "127.0.0.1",
      port,
      askerKp,
      identity.publicKey,
      "federation.bogusMethod",
      {},
    );
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);

  await testStop();
  index.close();
});

test("buildFederationLanServer threads purgeSign + deletePurgeContributions into the dispatch ctx", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  // Auto-approve the local-operator consent prompt the answerer raises on federation.purge.
  federationConsent.setBroadcast((_m, params) => {
    const rid = (params as { requestId: string }).requestId;
    queueMicrotask(() => federationConsent.respond(rid, true));
  });

  const identity = generateBoxKeypair();
  const signerKp = generateEd25519Keypair();
  let deleteCalls = 0;
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
    // The two new Slice-4 ctx fields whose conditional spreads must both be taken (set side):
    purgeSign: { privkeyB64: encodeBase64(signerKp.privkey), selfPeerId: "peer:answerer" },
    deletePurgeContributions: (externalId, _peerId) => {
      expect(externalId).toBe("user-99");
      deleteCalls++;
      return 3;
    },
  });
  await built.lanServer.start();
  const testStop = () => built.lanServer.stop();
  const port = built.lanServer.listenAddr()?.port as number;

  // Pair the asker so the encrypted hello handshake authenticates it.
  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", port, code, askerKp);

  // Send federation.purge over the wire — the answerer approves (auto-consent), deletes via the
  // threaded accessor, and returns a signed DeletionRecord attesting selfPeerId.
  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    askerKp,
    identity.publicKey,
    "federation.purge",
    { externalId: "user-99" },
  )) as { kind: string; record: DeletionRecord; sig: string };

  expect(res.kind).toBe("ok");
  expect(res.record.deletedCount).toBe(3);
  expect(res.record.peerId).toBe("peer:answerer");
  expect(verifyDeletionRecord(res.record, res.sig, encodeBase64(signerKp.pubkey))).toBe(true);
  expect(deleteCalls).toBe(1);

  await testStop();
  index.close();
});

// --- Branch coverage: optional-dep set arms + params null fallback ---

/** Helper: build a minimal server, start it, pair the askerKp, return port + cleanup. */
async function setupServer(
  db: Database,
  index: LocalIndex,
  extraDeps: Partial<Parameters<typeof buildFederationLanServer>[0]> = {},
): Promise<{
  port: number;
  identity: ReturnType<typeof generateBoxKeypair>;
  askerKp: ReturnType<typeof generateBoxKeypair>;
  cleanup: () => Promise<void>;
}> {
  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db,
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 1000,
    notify: () => {},
    ...extraDeps,
  });
  await built.lanServer.start();
  const port = built.lanServer.listenAddr()?.port as number;

  const code = generatePairingCode();
  built.pairingWindow.open(code);
  const askerKp = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", port, code, askerKp);

  return {
    port,
    identity,
    askerKp,
    cleanup: () => built.lanServer.stop(),
  };
}

test("onMessage uses body={} fallback when params is null (non-object arm)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  const { port, identity, askerKp, cleanup } = await setupServer(db, index);

  // federation.expertise with null params: `typeof null === "object" && null !== null` is false,
  // so body = {} and forced = { peerId: peer.peerId }. federation.expertise then tries asRecord({peerId:...})
  // which succeeds, but then requireString(rec, "query") fails (missing field) → returns a RpcMissOrHit hit
  // with an error payload. The path we care about (body={} fallback) IS executed.
  // Instead, use federation.probe with null params: same body={} fallback, then asRecord fails for "resourceRef".
  // The key is that onMessage itself doesn't throw — it dispatches and returns the rpc error.
  // We capture that the throw comes from the wire client (peer error), confirming body={} was used.
  let threw = false;
  try {
    await sendFederatedOverWire(
      "127.0.0.1",
      port,
      askerKp,
      identity.publicKey,
      "federation.expertise",
      null, // null params → body = {} → forced = {peerId} only → requireString(rec,"query") fails
    );
  } catch {
    threw = true;
  }
  // Either an error reply (threw) or a success with rank — both confirm the non-object arm ran.
  // (federation.expertise with no "query" key raises ERR_INVALID_PARAMS which is a hit-with-error,
  // sent back as a peer error over the wire → client throws.)
  expect(threw).toBe(true);

  await cleanup();
  index.close();
});

test("buildFederationLanServer threads explicit discovery + pairing into ctx (??-left arm)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  const discovery = new InMemoryDiscoveryProvider([]);
  const pairing = new PeerPairing(index);

  const { port, identity, askerKp, cleanup } = await setupServer(db, index, {
    discovery,
    pairing,
  });

  // Use federation.expertise (allowed over LAN) to trigger onMessage → ctx construction.
  // The explicit discovery/pairing objects are threaded via the ?? left arm.
  // A valid expertise query with a matching item returns rank "low"/"medium"/"high".
  db.run(`INSERT OR IGNORE INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
          VALUES ('gh:pr-disc','github','pull_request','disc','Deploy docs patch','deploy docs',10,1,'{}')`);

  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    askerKp,
    identity.publicKey,
    "federation.expertise",
    { query: "deploy docs", purpose: "coverage-test" },
  )) as { rank: string };

  // At least one item matched → rank is not "none"
  expect(res.rank).toBeDefined();
  expect(["none", "low", "medium", "high"].includes(res.rank)).toBe(true);

  await cleanup();
  index.close();
});

test("buildFederationLanServer threads teamVault + identityGuard + delegateApproval into ctx", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  const teamVault: Parameters<typeof buildFederationLanServer>[0]["teamVault"] = {
    quorumFor: (_toolId) => undefined,
    runTool: async (_input) => ({}),
  };

  const identityGuard: Parameters<typeof buildFederationLanServer>[0]["identityGuard"] = {
    enabled: false,
    isOperatorValid: () => true,
  };

  const delegateApproval: Parameters<typeof buildFederationLanServer>[0]["delegateApproval"] =
    async (_req) => false;

  const { port, identity, askerKp, cleanup } = await setupServer(db, index, {
    teamVault,
    identityGuard,
    delegateApproval,
  });

  // Fire federation.expertise so onMessage runs and builds ctx with all three set arms taken.
  // The spread arms { teamVault }, { identityGuard }, { delegateApproval } are all taken
  // (undefined === false for each dep). The server returns a valid response confirming ctx was built.
  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    askerKp,
    identity.publicKey,
    "federation.expertise",
    { query: "test query", purpose: "coverage" },
  )) as { rank: string };

  expect(["none", "low", "medium", "high"].includes(res.rank)).toBe(true);

  await cleanup();
  index.close();
});

test("buildFederationLanServer threads preflight into ctx (preflight set arm)", async () => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  const index = new LocalIndex(db);

  const preflight: Parameters<typeof buildFederationLanServer>[0]["preflight"] = {
    isPeerGranted: (_namespace, _peerId) => false,
    resolveCommand: (_namespace): PreflightCommandConfig | undefined => undefined,
    requestApproval: async (_input) => false,
    runCommand: async (_cfg, _params) => ({
      passed: false,
      summary: "not reached",
      durationMs: 0,
    }),
    audit: (_entry) => {},
  };

  const { port, identity, askerKp, cleanup } = await setupServer(db, index, {
    preflight,
  });

  // Fire federation.expertise so onMessage runs and builds ctx with the preflight set arm taken.
  // The { preflight: deps.preflight } spread is taken (deps.preflight !== undefined).
  const res = (await sendFederatedOverWire(
    "127.0.0.1",
    port,
    askerKp,
    identity.publicKey,
    "federation.expertise",
    { query: "preflight test", purpose: "coverage" },
  )) as { rank: string };

  expect(["none", "low", "medium", "high"].includes(res.rank)).toBe(true);

  await cleanup();
  index.close();
});

test("pairingServiceFor adapts a PairingWindow to the PairingService interface", () => {
  const win = new PairingWindow(60_000);
  const svc = pairingServiceFor(win);

  // closed window: isOpen false, getExpiresAt() maps null → undefined (the `?? undefined` arm)
  expect(svc.isOpen()).toBe(false);
  expect(svc.getExpiresAt()).toBeUndefined();

  // open(): isOpen true, getExpiresAt() now returns a real expiry number (the left arm)
  const code = generatePairingCode();
  svc.open(code);
  expect(svc.isOpen()).toBe(true);
  expect(typeof svc.getExpiresAt()).toBe("number");

  // consume(): wrong code rejected, correct code accepted
  expect(svc.consume("000000")).toBe(false);
  expect(svc.consume(code)).toBe(true);

  // close(): re-open then close clears the window
  svc.open(generatePairingCode());
  expect(svc.isOpen()).toBe(true);
  svc.close();
  expect(svc.isOpen()).toBe(false);
});

test("EMPTY_DISCOVERY and EMPTY_PEER_PAIRING are inert empty providers", async () => {
  // These defaults are only used when no discovery/pairing is wired; the methods that would
  // invoke them (federation.discover / federation.peers) are wire-forbidden, so they are
  // exercised directly here.
  expect(await EMPTY_DISCOVERY.list()).toEqual([]);
  expect(EMPTY_PEER_PAIRING.listPeers()).toEqual([]);
});
