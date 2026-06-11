import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "../index/known-namespace-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import { fanOutExpertise, fanOutQuery } from "./peer-fanout.ts";

const SELF: BoxKeypair = { publicKey: new Uint8Array(32), secretKey: new Uint8Array(32) };

function seedTwoPeers(db: Database): LocalIndex {
  const idx = new LocalIndex(db);
  idx.addLanPeer({
    peerId: "peer:aa",
    peerPubkey: new Uint8Array(32).fill(1),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7401,
    displayName: "Alice",
  });
  idx.addLanPeer({
    peerId: "peer:bb",
    peerPubkey: new Uint8Array(32).fill(2),
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: 7402,
    displayName: "Bob",
  });
  return idx;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("fanOutQuery", () => {
  it("aggregates answered peers and records the namespace cache", async () => {
    const db = freshDb();
    const index = seedTwoPeers(db);
    const store = new KnownNamespaceStore(db);
    const send = async (_h: string, _p: number, _s: BoxKeypair, pubkey: Uint8Array) => {
      if (pubkey[0] === 1) {
        return {
          items: [
            {
              id: "i1",
              service: "github",
              type: "pr",
              title: "fix auth race",
              snippet: "x",
              modifiedAt: 10,
            },
          ],
        };
      }
      throw new Error("lan-client: peer error no_grant");
    };
    const out = await fanOutQuery(
      { index, selfIdentity: SELF, sendOverWire: send, store, now: () => 5 },
      { namespace: "project:zurich", purpose: "ghost", types: ["pr"] },
    );
    expect(out.perPeer).toEqual([
      {
        peerId: "peer:aa",
        displayName: "Alice",
        items: [
          {
            id: "i1",
            service: "github",
            type: "pr",
            title: "fix auth race",
            snippet: "x",
            modifiedAt: 10,
          },
        ],
      },
    ]);
    expect(out.gaps).toHaveLength(1);
    expect(out.gaps[0]?.detail).toContain("Bob");
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "project:zurich" }]);
  });

  it("silently skips peers with a null host (matches team.auditMerged)", async () => {
    const db = freshDb();
    const idx = new LocalIndex(db);
    idx.addLanPeer({
      peerId: "peer:cc",
      peerPubkey: new Uint8Array(32).fill(3),
      direction: "inbound",
      displayName: "Carol",
    });
    const out = await fanOutQuery(
      {
        index: idx,
        selfIdentity: SELF,
        sendOverWire: async () => ({ items: [] }),
        store: new KnownNamespaceStore(db),
      },
      { namespace: "ns", purpose: "ghost" },
    );
    expect(out.perPeer).toEqual([]);
    expect(out.gaps).toEqual([]);
  });
});

describe("fanOutExpertise", () => {
  it("returns one rank per answering peer, sorted by peerId", async () => {
    const db = freshDb();
    const index = seedTwoPeers(db);
    const send = async (_h: string, _p: number, _s: BoxKeypair, pubkey: Uint8Array) =>
      pubkey[0] === 1 ? { rank: "high" } : { rank: "none" };
    const out = await fanOutExpertise(
      { index, selfIdentity: SELF, sendOverWire: send, store: new KnownNamespaceStore(db) },
      { query: "auth.ts", purpose: "ghost" },
    );
    expect(out.perPeer).toEqual([
      { peerId: "peer:aa", displayName: "Alice", rank: "high" },
      { peerId: "peer:bb", displayName: "Bob", rank: "none" },
    ]);
  });
});
