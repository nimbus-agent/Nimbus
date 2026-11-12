/**
 * V95 - `lan_peers.proto_version`: the downgrade ratchet's memory (Phase 10 FS1, LAN forward secrecy
 * spec § 6, D-FS-13).
 *
 * `1` is the old static-box wire, `2` a Noise IK session. The value is written to 2 by exactly one
 * function, `LocalIndex.markLanPeerProto`, after a v2 handshake completed with that peer, and is
 * never lowered by anything (its upsert is `MAX(...)`; `addLanPeer`'s upsert does not touch it).
 * Every row that exists at this migration was made over the old wire and starts at 1.
 *
 * Additive column, forward-only: `DEFAULT 1` is the correct backfill. The runner guards the `ALTER`
 * with a column probe so the step can run twice.
 */
export const LAN_PEER_PROTO_V95_SQL = `
ALTER TABLE lan_peers ADD COLUMN proto_version INTEGER NOT NULL DEFAULT 1 CHECK (proto_version IN (1, 2));
`;
