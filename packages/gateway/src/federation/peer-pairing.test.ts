import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { generateBoxKeypair } from "../ipc/lan-crypto.ts";
import { PeerPairing } from "./peer-pairing.ts";

let index: LocalIndex;
beforeEach(() => {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
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

test("approveInboundPair with all optional fields set persists hostPort and displayName", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({
    peerPubkey: peerKey,
    hostIp: "alice.local",
    hostPort: 7475,
    displayName: "alice-laptop",
  });
  const peerId = pairing.approveInboundPair(req);
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.host_ip).toBe("alice.local");
  expect(row?.host_port).toBe(7475);
  expect(row?.display_name).toBe("alice-laptop");
  expect(row?.direction).toBe("inbound");
});

test("approveInboundPair with no optional fields yields null host_ip, host_port, display_name", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;
  const req = pairing.beginInboundPair({ peerPubkey: peerKey });
  const peerId = pairing.approveInboundPair(req);
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.host_ip).toBeNull();
  expect(row?.host_port).toBeNull();
  expect(row?.display_name).toBeNull();
  expect(row?.write_allowed).toBe(0);
});

test("initiatePair stores correct hostIp and hostPort on the peer row", async () => {
  const peerKey = generateBoxKeypair().publicKey;
  const fakeHandshake = async (_host: string, _port: number, _code: string) => peerKey;
  const pairing = new PeerPairing(index, fakeHandshake);
  const peerId = await pairing.initiatePair("192.168.1.42", 9000, "TESTCODE");
  const row = index.getLanPeerByPubkey(peerKey);
  expect(row?.peer_id).toBe(peerId);
  expect(row?.host_ip).toBe("192.168.1.42");
  expect(row?.host_port).toBe(9000);
  expect(row?.direction).toBe("outbound");
});

test("peerIdFor produces stable hex-prefix peer id across two separate approvals of distinct keys", () => {
  const pairing = new PeerPairing(index);
  const keyA = generateBoxKeypair().publicKey;
  const keyB = generateBoxKeypair().publicKey;
  const idA = pairing.approveInboundPair(pairing.beginInboundPair({ peerPubkey: keyA }));
  const idB = pairing.approveInboundPair(pairing.beginInboundPair({ peerPubkey: keyB }));
  expect(idA).toMatch(/^peer:[0-9a-f]{16}$/);
  expect(idB).toMatch(/^peer:[0-9a-f]{16}$/);
  expect(idA).not.toBe(idB);
});

test("approveInboundPair second call for same pubkey overwrites direction (upsert)", () => {
  const pairing = new PeerPairing(index);
  const peerKey = generateBoxKeypair().publicKey;
  pairing.approveInboundPair(
    pairing.beginInboundPair({ peerPubkey: peerKey, hostIp: "first.test" }),
  );
  expect(pairing.listPeers().length).toBe(1);
  // Re-approve same key — ON CONFLICT upsert, still one row
  pairing.approveInboundPair(
    pairing.beginInboundPair({ peerPubkey: peerKey, hostIp: "second.test" }),
  );
  const peers = pairing.listPeers();
  expect(peers.length).toBe(1);
  expect(peers[0]?.host_ip).toBe("second.test");
});
