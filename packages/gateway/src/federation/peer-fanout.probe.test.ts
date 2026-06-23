import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { fanOutProbe } from "./peer-fanout.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

function onePeer(db: Database): LocalIndex {
  const idx = new LocalIndex(db);
  idx.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  return idx;
}

describe("fanOutProbe", () => {
  it("maps a peer's answer into a PeerProbeResult", async () => {
    const db = freshDb();
    const index = onePeer(db);
    const store = new KnownNamespaceStore(db);
    const send = async () => ({ touched: true, lastSeenDaysAgo: 2 });
    const out = await fanOutProbe(
      { index, selfIdentity: SELF, sendOverWire: send, store },
      { resourceRef: "i-12345", purpose: "janitor" },
    );
    expect(out.perPeer).toEqual([
      { peerId: "peer:aa", displayName: "Alice", touched: true, lastSeenDaysAgo: 2 },
    ]);
    expect(out.gaps).toEqual([]);
  });

  it("an untouched answer maps lastSeenDaysAgo to null", async () => {
    const db = freshDb();
    const index = onePeer(db);
    const store = new KnownNamespaceStore(db);
    const send = async () => ({ touched: false });
    const out = await fanOutProbe(
      { index, selfIdentity: SELF, sendOverWire: send, store },
      { resourceRef: "i-12345", purpose: "janitor" },
    );
    expect(out.perPeer[0]).toEqual({
      peerId: "peer:aa",
      displayName: "Alice",
      touched: false,
      lastSeenDaysAgo: null,
    });
  });

  it("a transport error becomes a gap (never counted as idle)", async () => {
    const db = freshDb();
    const index = onePeer(db);
    const store = new KnownNamespaceStore(db);
    const send = async () => {
      throw new Error("timeout");
    };
    const out = await fanOutProbe(
      { index, selfIdentity: SELF, sendOverWire: send, store },
      { resourceRef: "i-12345", purpose: "janitor" },
    );
    expect(out.perPeer).toEqual([]);
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.detail).toContain("timeout");
  });
});
