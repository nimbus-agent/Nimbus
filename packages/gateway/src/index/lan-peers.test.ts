import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "./local-index.ts";

function newIdx(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return new LocalIndex(db);
}

describe("LocalIndex.addLanPeer (S3-F5)", () => {
  test("first add inserts a row", () => {
    const idx = newIdx();
    const pub = new Uint8Array(32).fill(7);
    idx.addLanPeer({
      peerId: "peer-1",
      peerPubkey: pub,
      direction: "inbound",
      hostIp: "192.0.2.1",
    });
    const fetched = idx.getLanPeerByPubkey(pub);
    expect(fetched?.peer_id).toBe("peer-1");
    expect(fetched?.host_ip).toBe("192.0.2.1");
  });

  test("re-pair from same pubkey is idempotent (no UNIQUE constraint throw)", () => {
    const idx = newIdx();
    const pub = new Uint8Array(32).fill(7);
    idx.addLanPeer({
      peerId: "peer-1",
      peerPubkey: pub,
      direction: "inbound",
      hostIp: "192.0.2.1",
    });
    expect(() =>
      idx.addLanPeer({
        peerId: "peer-1",
        peerPubkey: pub,
        direction: "inbound",
        hostIp: "192.0.2.2",
      }),
    ).not.toThrow();
    const fetched = idx.getLanPeerByPubkey(pub);
    expect(fetched?.host_ip).toBe("192.0.2.2");
  });

  test("re-pair refreshes host_ip / host_port / display_name / paired_at", async () => {
    const idx = newIdx();
    const pub = new Uint8Array(32).fill(11);
    idx.addLanPeer({
      peerId: "peer-1",
      peerPubkey: pub,
      direction: "inbound",
      hostIp: "192.0.2.1",
      hostPort: 7475,
      displayName: "macbook",
    });
    const before = idx.getLanPeerByPubkey(pub);
    await new Promise((r) => setTimeout(r, 5));
    idx.addLanPeer({
      peerId: "peer-1",
      peerPubkey: pub,
      direction: "outbound",
      hostIp: "192.0.2.99",
      hostPort: 9999,
      displayName: "phone",
    });
    const after = idx.getLanPeerByPubkey(pub);
    expect(after?.host_ip).toBe("192.0.2.99");
    expect(after?.host_port).toBe(9999);
    expect(after?.display_name).toBe("phone");
    expect(after?.direction).toBe("outbound");
    expect(after?.paired_at).not.toBe(before?.paired_at);
  });

  test("re-pair preserves write_allowed grant (does not silently re-elevate)", () => {
    const idx = newIdx();
    const pub = new Uint8Array(32).fill(13);
    idx.addLanPeer({
      peerId: "peer-grant",
      peerPubkey: pub,
      direction: "inbound",
    });
    idx.grantLanWrite("peer-grant");
    expect(idx.getLanPeerByPubkey(pub)?.write_allowed).toBe(1);
    idx.addLanPeer({
      peerId: "peer-grant",
      peerPubkey: pub,
      direction: "inbound",
      hostIp: "192.0.2.5",
    });
    expect(idx.getLanPeerByPubkey(pub)?.write_allowed).toBe(1);
  });

  test("getLanPeerByPubkey returns null/undefined for unknown pubkey", () => {
    const idx = newIdx();
    const got = idx.getLanPeerByPubkey(new Uint8Array(32).fill(99));
    expect(got == null).toBe(true);
  });
});
