import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface LanPeerInsert {
  peerId: string;
  peerPubkey: Uint8Array;
  direction: "inbound" | "outbound";
  hostIp?: string;
  hostPort?: number;
  displayName?: string;
  /**
   * D-FS-17: 2 for a peer made by an `XXpsk0` pairing. Absent for the legacy `pair` frame, whose
   * insert leaves the column at its default (1) and never touches an existing row's value; a
   * present value raises it with `MAX`, so a re-pairing can never lower it.
   */
  protoVersion?: 1 | 2;
}

const UPSERT = `ON CONFLICT(peer_pubkey) DO UPDATE SET
         host_ip = excluded.host_ip,
         host_port = excluded.host_port,
         display_name = excluded.display_name,
         direction = excluded.direction,
         paired_at = excluded.paired_at`;

/** Inserts or refreshes a `lan_peers` row (`LocalIndex.addLanPeer`). */
export function insertLanPeer(db: Database, params: LanPeerInsert): void {
  const values = [
    params.peerId,
    Buffer.from(params.peerPubkey),
    params.direction,
    params.hostIp ?? null,
    params.hostPort ?? null,
    params.displayName ?? null,
    new Date().toISOString(),
  ];
  if (params.protoVersion === undefined) {
    dbRun(
      db,
      `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, host_ip, host_port, display_name, write_allowed, paired_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)
       ${UPSERT}`,
      values,
    );
    return;
  }
  dbRun(
    db,
    `INSERT INTO lan_peers (peer_id, peer_pubkey, direction, host_ip, host_port, display_name, write_allowed, paired_at, proto_version)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ${UPSERT},
         proto_version = MAX(proto_version, excluded.proto_version)`,
    [...values, params.protoVersion],
  );
}
