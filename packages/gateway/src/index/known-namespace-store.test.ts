import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { KnownNamespaceStore } from "./known-namespace-store.ts";
import { LocalIndex } from "./local-index.ts";
import { runIndexedSchemaMigrations } from "./migrations/runner.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 38);
  return db;
}

describe("KnownNamespaceStore", () => {
  let db: Database;
  let store: KnownNamespaceStore;
  beforeEach(() => {
    db = freshDb();
    store = new KnownNamespaceStore(db);
  });
  afterEach(() => db.close());

  it("records (peerId, namespace) and lists it", () => {
    store.record("peer:aa", "project:zurich", 1000);
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "project:zurich" }]);
  });

  it("record is idempotent on the primary key and updates last_used_at", () => {
    store.record("peer:aa", "project:zurich", 1000);
    store.record("peer:aa", "project:zurich", 2000);
    const rows = db
      .query("SELECT first_seen_at, last_used_at FROM federation_known_namespaces")
      .all() as Array<{ first_seen_at: number; last_used_at: number }>;
    expect(rows).toEqual([{ first_seen_at: 1000, last_used_at: 2000 }]);
  });

  it("prune removes a single (peerId, namespace)", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:aa", "ns2", 1);
    store.prune("peer:aa", "ns1");
    expect(store.list()).toEqual([{ peerId: "peer:aa", namespace: "ns2" }]);
  });

  it("pruneAllForPeer removes every row for a peer", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:bb", "ns2", 1);
    store.pruneAllForPeer("peer:aa");
    expect(store.list()).toEqual([{ peerId: "peer:bb", namespace: "ns2" }]);
  });

  it("listForPeer filters to one peer", () => {
    store.record("peer:aa", "ns1", 1);
    store.record("peer:bb", "ns2", 1);
    expect(store.listForPeer("peer:aa")).toEqual(["ns1"]);
  });
});

describe("removeLanPeer cascade-prunes the namespace cache", () => {
  it("drops known-namespace rows when a peer is unpaired", () => {
    const db = freshDb();
    const idx = new LocalIndex(db);
    const store = new KnownNamespaceStore(db);
    store.record("peer:gone", "ns1", 1);
    idx.removeLanPeer("peer:gone");
    expect(store.listForPeer("peer:gone")).toEqual([]);
    db.close();
  });
});
