import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../local-index.ts";
import { maxRegisteredIndexedSchemaVersion, runIndexedSchemaMigrations } from "./runner.ts";

const PUBKEY = new Uint8Array(32).fill(7);

function columnInfo(
  db: Database,
): { name: string; type: string; notnull: number; dflt_value: string | null }[] {
  return db.query("PRAGMA table_info(lan_peers)").all() as {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }[];
}

describe("V95 migration - lan_peers.proto_version (Phase 10 FS1)", () => {
  test("a V93 database with a peer row gains proto_version = 1 and the constant agrees", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, 93); // V94 is a placeholder step, see runner.ts
      expect(columnInfo(db).map((c) => c.name)).not.toContain("proto_version");
      db.run(
        `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, write_allowed, paired_at)
         VALUES ('peer:a', ?, 'outbound', 0, 'now')`,
        [Buffer.from(PUBKEY)],
      );
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT proto_version FROM lan_peers").get()).toEqual({ proto_version: 1 });
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_SCHEMA_VERSION,
      });
      expect(CURRENT_SCHEMA_VERSION).toBe(maxRegisteredIndexedSchemaVersion());
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(95);
    } finally {
      db.close();
    }
  });

  test("the column is INTEGER NOT NULL DEFAULT 1 and refuses a version other than 1 or 2", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      const col = columnInfo(db).find((c) => c.name === "proto_version");
      expect(col).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
      const insert = (version: number | null) =>
        db.run(
          `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, write_allowed, paired_at, proto_version)
           VALUES (?, ?, 'outbound', 0, 'now', ?)`,
          [`peer:${String(version)}`, Buffer.from(new Uint8Array(32).fill(version ?? 0)), version],
        );
      expect(() => insert(3)).toThrow();
      expect(() => insert(0)).toThrow();
      expect(() => insert(null)).toThrow();
      insert(2);
    } finally {
      db.close();
    }
  });
});

describe("LocalIndex.markLanPeerProto - the downgrade ratchet's only writer", () => {
  function withIndex(fn: (index: LocalIndex) => void): void {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      fn(new LocalIndex(db));
    } finally {
      db.close();
    }
  }

  function add(index: LocalIndex): void {
    index.addLanPeer({ peerId: "peer:a", peerPubkey: PUBKEY, direction: "outbound" });
  }

  test("raises 1 to 2, never lowers it, and ignores an unknown pubkey", () => {
    withIndex((index) => {
      add(index);
      expect(index.getLanPeerByPubkey(PUBKEY)?.proto_version).toBe(1);
      index.markLanPeerProto(PUBKEY, 2);
      expect(index.getLanPeerByPubkey(PUBKEY)?.proto_version).toBe(2);
      index.markLanPeerProto(PUBKEY, 1);
      expect(index.getLanPeerByPubkey(PUBKEY)?.proto_version).toBe(2);
      index.markLanPeerProto(new Uint8Array(32).fill(9), 2);
      expect(index.listLanPeers()).toHaveLength(1);
    });
  });

  test("a re-pair through addLanPeer does not lower a ratcheted peer", () => {
    withIndex((index) => {
      add(index);
      index.markLanPeerProto(PUBKEY, 2);
      add(index);
      expect(index.getLanPeerByPubkey(PUBKEY)?.proto_version).toBe(2);
      expect(index.listLanPeers()[0]?.proto_version).toBe(2);
    });
  });
});

describe("V95 migration re-runs", () => {
  test("rewinding user_version and running every step again is idempotent and keeps a ratcheted row", () => {
    const db = new Database(":memory:");
    try {
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      db.run(
        `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, write_allowed, paired_at, proto_version)
         VALUES ('peer:a', ?, 'outbound', 0, 'now', 2)`,
        [Buffer.from(PUBKEY)],
      );
      db.run("PRAGMA user_version = 93");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      expect(db.query("SELECT proto_version FROM lan_peers").get()).toEqual({ proto_version: 2 });
    } finally {
      db.close();
    }
  });
});
