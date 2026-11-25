import type { LocalIndex } from "../index/local-index.ts";
import type { LanLink } from "../ipc/lan-client.ts";

/** The slice of `LanPeerRow` the link policy reads. */
export interface LanLinkRow {
  peer_pubkey: Uint8Array;
  proto_version: number;
}

/**
 * Builds the outbound link policy for one paired peer (invariant I56, the initiator half of the
 * ratchet record): `known` comes from the row, and a completed v2 handshake writes the ratchet through
 * `markLanPeerProto`, the only writer of `proto_version` (status reads it to name a peer still on 1).
 */
export function lanLinkFor(
  row: LanLinkRow,
  index: Pick<LocalIndex, "markLanPeerProto" | "getLanPeerByPubkey">,
): LanLink {
  return {
    // Read when the handshake completes, not when the link is built: another exchange may have
    // ratcheted the peer in between. It never goes down (the version the link was built with counts too).
    get known(): 1 | 2 {
      const live = index.getLanPeerByPubkey(row.peer_pubkey)?.proto_version;
      return row.proto_version === 2 || live === 2 ? 2 : 1;
    },
    onNegotiated: (version) => index.markLanPeerProto(row.peer_pubkey, version),
  };
}
