import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { lanLinkFor } from "./lan-link.ts";

const PUBKEY = new Uint8Array(32).fill(5);

function withIndex(fn: (index: LocalIndex) => void): void {
  const db = new Database(":memory:");
  try {
    runIndexedSchemaMigrations(db, LocalIndex.SCHEMA_VERSION);
    const index = new LocalIndex(db);
    index.addLanPeer({ peerId: "peer:a", peerPubkey: PUBKEY, direction: "outbound" });
    fn(index);
  } finally {
    db.close();
  }
}

describe("lanLinkFor", () => {
  test("known comes from the row, minProtocol from the index, and a new peer is at 1", () => {
    withIndex((index) => {
      const row = index.getLanPeerByPubkey(PUBKEY) as NonNullable<
        ReturnType<typeof index.getLanPeerByPubkey>
      >;
      const link = lanLinkFor(row, index);
      expect(link.known).toBe(1);
      expect(link.minProtocol).toBe(1);
      index.setLanMinProtocol(2);
      expect(lanLinkFor(row, index).minProtocol).toBe(2);
    });
  });

  test("onNegotiated writes the ratchet to real SQLite, and known never goes down", () => {
    withIndex((index) => {
      const row = index.getLanPeerByPubkey(PUBKEY) as NonNullable<
        ReturnType<typeof index.getLanPeerByPubkey>
      >;
      lanLinkFor(row, index).onNegotiated?.(2);
      const after = index.getLanPeerByPubkey(PUBKEY);
      expect(after?.proto_version).toBe(2);
      expect(lanLinkFor(after as NonNullable<typeof after>, index).known).toBe(2);
      // Re-pairing through the legacy upsert leaves the ratchet where it was.
      index.addLanPeer({ peerId: "peer:a", peerPubkey: PUBKEY, direction: "outbound" });
      expect(index.getLanPeerByPubkey(PUBKEY)?.proto_version).toBe(2);
    });
  });

  test("an out-of-range recorded version reads as 1", () => {
    withIndex((index) => {
      const link = lanLinkFor({ peer_pubkey: PUBKEY, proto_version: 7 }, index);
      expect(link.known).toBe(1);
    });
  });
});
