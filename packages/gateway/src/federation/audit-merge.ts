import type { FederationAuditEntry } from "./audit-export.ts";

export interface PeerAuditStream {
  peerId: string;
  entries: FederationAuditEntry[];
}
export interface MergedAuditEntry extends FederationAuditEntry {
  peerId: string;
}

/** Flatten + tag each entry with its peer + sort ascending by timestamp. */
export function mergeTeamAudit(streams: readonly PeerAuditStream[]): MergedAuditEntry[] {
  const out: MergedAuditEntry[] = [];
  for (const s of streams) for (const e of s.entries) out.push({ ...e, peerId: s.peerId });
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}
