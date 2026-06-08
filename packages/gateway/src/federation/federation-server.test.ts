import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { bytesToHex } from "@noble/hashes/utils.js";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "../ipc/federation-rpc.ts";
import { outboundPairHandshake, sendFederatedOverWire } from "../ipc/lan-client.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { generatePairingCode } from "../ipc/lan-pairing.ts";
import { type DeletionRecord, verifyDeletionRecord } from "../policy/deletion-record.ts";
import { federationConsent } from "./consent-broker.ts";
import { InMemoryDiscoveryProvider } from "./discovery.ts";
import { buildFederationLanServer } from "./federation-server.ts";
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
