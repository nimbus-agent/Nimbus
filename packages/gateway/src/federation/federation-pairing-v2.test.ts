/**
 * FS2: pairing through the real federation seams. The host side (`buildFederationLanServer`) and the
 * initiator side (`PeerPairing` with the production `outboundPairHandshake`), each on its own index:
 * both rows start at protocol 2 (D-FS-17), a re-pairing can never lower it, and a pairing under
 * `min_protocol = 2` works.
 */
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { type LanPeerRow, LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { outboundPairHandshake } from "../ipc/lan-pair-client.ts";
import { generatePairingCode } from "../ipc/lan-pairing.ts";
import { buildFederationLanServer } from "./federation-server.ts";
import { PeerPairing } from "./peer-pairing.ts";

let stop: (() => Promise<void>) | undefined;
afterEach(async () => {
  await new Promise((r) => setTimeout(r, 25));
  await stop?.();
  stop = undefined;
});

function freshIndex(): LocalIndex {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
  return new LocalIndex(db);
}

async function startHost(minProtocol?: 1 | 2) {
  const index = freshIndex();
  const identity = generateBoxKeypair();
  const built = buildFederationLanServer({
    db: new Database(":memory:"),
    index,
    identity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 5,
      lockoutSeconds: 60,
      ...(minProtocol === undefined ? {} : { minProtocol }),
    },
    consentTimeoutMs: 1000,
    notify: () => {},
  });
  await built.lanServer.start();
  stop = () => built.lanServer.stop();
  return { index, identity, built, port: built.lanServer.listenAddr()?.port as number };
}

test("a v2 pairing writes protocol 2 on BOTH rows, with the key the host presented", async () => {
  const host = await startHost();
  const askerKp = generateBoxKeypair();
  const askerIndex = freshIndex();
  const pairing = new PeerPairing(askerIndex, (h, p, c) => outboundPairHandshake(h, p, c, askerKp));
  const code = generatePairingCode();
  host.built.pairingWindow.open(code);
  await pairing.initiatePair("127.0.0.1", host.port, code);

  const hostRow = host.index.getLanPeerByPubkey(askerKp.publicKey) as LanPeerRow;
  expect(hostRow.proto_version).toBe(2);
  expect(hostRow.direction).toBe("inbound");
  expect(hostRow.write_allowed).toBe(0);
  const askerRow = askerIndex.getLanPeerByPubkey(host.identity.publicKey) as LanPeerRow;
  expect(askerRow.proto_version).toBe(2);
  expect(askerRow.direction).toBe("outbound");
  expect(host.built.pairingWindow.isOpen()).toBe(false);
});

test("a pairing under min_protocol = 2 works, and a wrong code registers nothing", async () => {
  const host = await startHost(2);
  const code = generatePairingCode();
  host.built.pairingWindow.open(code);
  const bad = generateBoxKeypair();
  const wrongCode = generatePairingCode();
  const err = await outboundPairHandshake("127.0.0.1", host.port, wrongCode, bad, 1_000).then(
    () => "resolved",
    (e: unknown) => (e as Error).message,
  );
  expect(err).toContain("no reply");
  expect(host.index.getLanPeerByPubkey(bad.publicKey)).toBeUndefined();
  expect(host.built.pairingWindow.isOpen()).toBe(true);
  const good = generateBoxKeypair();
  await outboundPairHandshake("127.0.0.1", host.port, code, good);
  expect(host.index.getLanPeerByPubkey(good.publicKey)?.proto_version).toBe(2);
});

test("addLanPeer: a v2 insert starts at 2, and no later upsert lowers it (D-FS-17)", () => {
  const index = freshIndex();
  const key = generateBoxKeypair().publicKey;
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound" });
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(1);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound", protoVersion: 2 });
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(2);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound" });
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(2);
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound", protoVersion: 1 });
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(2);
  // markLanPeerProto stays the other writer, also never lowering
  index.markLanPeerProto(key, 1);
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(2);
});

test("removing a peer deletes its protocol with the row; a new pairing starts at the version it was made with", () => {
  const index = freshIndex();
  const key = generateBoxKeypair().publicKey;
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound", protoVersion: 2 });
  index.removeLanPeer("peer:a");
  expect(index.getLanPeerByPubkey(key)).toBeUndefined();
  index.addLanPeer({ peerId: "peer:a", peerPubkey: key, direction: "inbound" });
  expect(index.getLanPeerByPubkey(key)?.proto_version).toBe(1);
});
