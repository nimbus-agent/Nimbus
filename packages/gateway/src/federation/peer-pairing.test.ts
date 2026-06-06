import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { PeerPairing } from "./peer-pairing.ts";

let index: LocalIndex;
beforeEach(() => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  index = new LocalIndex(db);
});
afterEach(() => index.close?.());

test("approveInboundPair persists an inbound peer only after owner approval", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;

  const req = pairing.beginInboundPair({
    peerPubkey: peerKey,
    hostIp: "bob-desktop.test",
    displayName: "bob-desktop",
  });
  expect(index.getLanPeerByPubkey(peerKey)).toBeUndefined();

  const peerId = pairing.approveInboundPair(req);
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.direction).toBe("inbound");
  expect(row?.write_allowed).toBe(0);
});

test("rejectInboundPair never persists the peer", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({ peerPubkey: peerKey, hostIp: "peer.test" });
  pairing.rejectInboundPair(req);
  expect(index.getLanPeerByPubkey(peerKey)).toBeUndefined();
});

test("listPeers reflects persisted peers", () => {
  const pairing = new PeerPairing(index);
  const k = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({ peerPubkey: k, hostIp: "peer.test" });
  pairing.approveInboundPair(req);
  expect(pairing.listPeers().length).toBe(1);
});

test("initiatePair persists an outbound peer using the injected handshake", async () => {
  const peerKey = generateBoxKeypair().publicKey;
  const fakeHandshake = async () => peerKey;
  const pairing = new PeerPairing(index, fakeHandshake);
  const peerId = await pairing.initiatePair("outbound-peer.test", 7475, "PAIRCODE000000000000");
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.direction).toBe("outbound");
  expect(row?.write_allowed).toBe(0);
});

test("initiatePair throws when no handshake is wired", async () => {
  const pairing = new PeerPairing(index);
  await expect(pairing.initiatePair("peer.test", 7475, "x")).rejects.toThrow("not wired");
});

test("removePeer unpairs a persisted peer", () => {
  const pairing = new PeerPairing(index);
  const k = generateBoxKeypair().publicKey;
  const peerId = pairing.approveInboundPair(
    pairing.beginInboundPair({ peerPubkey: k, hostIp: "peer.test" }),
  );
  expect(pairing.listPeers().length).toBe(1);
  pairing.removePeer(peerId);
  expect(pairing.listPeers().length).toBe(0);
});
