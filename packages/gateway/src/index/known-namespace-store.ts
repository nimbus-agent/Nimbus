import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface KnownNamespaceRow {
  readonly peerId: string;
  readonly namespace: string;
}

/**
 * Asker-side cache of remote namespaces this gateway has successfully queried (V38). Used by the
 * cross-colleague agents to default to an ambient fan-out. Rows are recorded only on an ANSWERED
 * federated query and pruned on no_grant / unpair (self-healing).
 */
export class KnownNamespaceStore {
  constructor(private readonly db: Database) {}

  record(peerId: string, namespace: string, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO federation_known_namespaces (peer_id, namespace, first_seen_at, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(peer_id, namespace)
       DO UPDATE SET last_used_at = excluded.last_used_at`,
      [peerId, namespace, nowMs, nowMs],
    );
  }

  prune(peerId: string, namespace: string): void {
    dbRun(this.db, `DELETE FROM federation_known_namespaces WHERE peer_id = ? AND namespace = ?`, [
      peerId,
      namespace,
    ]);
  }

  pruneAllForPeer(peerId: string): void {
    dbRun(this.db, `DELETE FROM federation_known_namespaces WHERE peer_id = ?`, [peerId]);
  }

  list(): KnownNamespaceRow[] {
    return this.db
      .query(
        `SELECT peer_id AS peerId, namespace FROM federation_known_namespaces
         ORDER BY peer_id ASC, namespace ASC`,
      )
      .all() as KnownNamespaceRow[];
  }

  listForPeer(peerId: string): string[] {
    return (
      this.db
        .query(
          `SELECT namespace FROM federation_known_namespaces WHERE peer_id = ? ORDER BY namespace ASC`,
        )
        .all(peerId) as Array<{ namespace: string }>
    ).map((r) => r.namespace);
  }
}
