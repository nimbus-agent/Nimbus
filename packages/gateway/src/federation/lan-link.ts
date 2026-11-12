import type { LocalIndex } from "../index/local-index.ts";
import type { LanLink } from "../ipc/lan-client.ts";

/** The slice of `LanPeerRow` the link policy reads. */
export interface LanLinkRow {
  peer_pubkey: Uint8Array;
  proto_version: number;
}

/**
 * Builds the outbound link policy for one paired peer (invariant I56, the initiator half of the
 * downgrade ratchet): `known` comes from the row, `minProtocol` from `[lan] min_protocol` (held by
 * the index, see `LocalIndex.setLanMinProtocol`), and a completed v2 handshake writes the ratchet
 * through `markLanPeerProto`, the only writer of `proto_version`.
 */
export function lanLinkFor(
  row: LanLinkRow,
  index: Pick<LocalIndex, "lanMinProtocol" | "markLanPeerProto">,
): LanLink {
  return {
    known: row.proto_version === 2 ? 2 : 1,
    minProtocol: index.lanMinProtocol(),
    onNegotiated: (version) => index.markLanPeerProto(row.peer_pubkey, version),
  };
}
