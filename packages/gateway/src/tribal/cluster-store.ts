import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export type TribalStatus = "pending" | "suggested" | "captured" | "dismissed";

export interface TribalCluster {
  clusterId: string;
  representativeQuestion: string;
  representativeVec: Float32Array | null;
  occurrenceCount: number;
  firstSeen: number;
  lastSeen: number;
  status: TribalStatus;
  channelId: string;
  platform: string;
  suggestedAt: number | null;
  cooldownUntil: number | null;
  capturedPageRef: string | null;
}

interface Row {
  cluster_id: string;
  representative_question: string;
  representative_vec: Uint8Array | null;
  occurrence_count: number;
  first_seen: number;
  last_seen: number;
  status: TribalStatus;
  channel_id: string;
  platform: string;
  suggested_at: number | null;
  cooldown_until: number | null;
  captured_page_ref: string | null;
}

function rowToCluster(r: Row): TribalCluster {
  return {
    clusterId: r.cluster_id,
    representativeQuestion: r.representative_question,
    representativeVec:
      r.representative_vec === null
        ? null
        : new Float32Array(
            r.representative_vec.buffer,
            r.representative_vec.byteOffset,
            r.representative_vec.byteLength / 4,
          ),
    occurrenceCount: r.occurrence_count,
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    status: r.status,
    channelId: r.channel_id,
    platform: r.platform,
    suggestedAt: r.suggested_at,
    cooldownUntil: r.cooldown_until,
    capturedPageRef: r.captured_page_ref,
  };
}

function vecBytes(v: Float32Array | null): Uint8Array | null {
  return v === null ? null : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
}

export class TribalClusterStore {
  constructor(private readonly db: Database) {}

  get(clusterId: string): TribalCluster | undefined {
    const r = this.db
      .query("SELECT * FROM tribal_clusters WHERE cluster_id = ?")
      .get(clusterId) as Row | null;
    return r === null ? undefined : rowToCluster(r);
  }

  listByStatus(status: TribalStatus): TribalCluster[] {
    return (
      this.db
        .query("SELECT * FROM tribal_clusters WHERE status = ? ORDER BY last_seen DESC")
        .all(status) as Row[]
    ).map(rowToCluster);
  }

  listAll(): TribalCluster[] {
    return (
      this.db.query("SELECT * FROM tribal_clusters ORDER BY last_seen DESC").all() as Row[]
    ).map(rowToCluster);
  }

  /** Clusters that carry a representative vector — the candidate set for nearest-cluster recall. */
  listWithVec(): TribalCluster[] {
    return (
      this.db
        .query("SELECT * FROM tribal_clusters WHERE representative_vec IS NOT NULL")
        .all() as Row[]
    )
      .map(rowToCluster)
      .filter((c) => c.representativeVec !== null);
  }

  count(): number {
    const r = this.db.query("SELECT count(*) AS n FROM tribal_clusters").get() as { n: number };
    return r.n;
  }

  /**
   * Record one observation. New cluster → pending(count 1). Existing in-cooldown → unchanged
   * unless cooldown expired (then reset to pending count 1). Otherwise bump count + last_seen.
   */
  upsertOccurrence(p: {
    clusterId: string;
    question: string;
    vec: Float32Array | null;
    channelId: string;
    platform: string;
    now: number;
  }): TribalCluster {
    const existing = this.get(p.clusterId);
    if (existing === undefined) {
      dbRun(
        this.db,
        `INSERT INTO tribal_clusters (cluster_id, representative_question, representative_vec, occurrence_count, first_seen, last_seen, status, channel_id, platform)
         VALUES (?, ?, ?, 1, ?, ?, 'pending', ?, ?)`,
        [p.clusterId, p.question, vecBytes(p.vec), p.now, p.now, p.channelId, p.platform],
      );
      return this.getOrThrow(p.clusterId);
    }
    const inCooldown = existing.cooldownUntil !== null && p.now < existing.cooldownUntil;
    if (inCooldown) return existing; // ignore occurrences during cooldown (review §3.2)
    const cooldownExpired = existing.cooldownUntil !== null && p.now >= existing.cooldownUntil;
    if (cooldownExpired) {
      dbRun(
        this.db,
        `UPDATE tribal_clusters SET occurrence_count = 1, first_seen = ?, last_seen = ?, status = 'pending', suggested_at = NULL, cooldown_until = NULL WHERE cluster_id = ?`,
        [p.now, p.now, p.clusterId],
      );
      return this.getOrThrow(p.clusterId);
    }
    // Backfill the representative vector if the cluster was first seen while the embedder was
    // offline (vec NULL) — otherwise the cluster stays invisible to recall-based near-dup merge
    // and a later near-identical question would spawn a duplicate cluster.
    dbRun(
      this.db,
      `UPDATE tribal_clusters
       SET occurrence_count = occurrence_count + 1, last_seen = ?,
           representative_vec = COALESCE(representative_vec, ?)
       WHERE cluster_id = ?`,
      [p.now, vecBytes(p.vec), p.clusterId],
    );
    return this.getOrThrow(p.clusterId);
  }

  markSuggested(clusterId: string, now: number): void {
    dbRun(
      this.db,
      `UPDATE tribal_clusters SET status = 'suggested', suggested_at = ? WHERE cluster_id = ?`,
      [now, clusterId],
    );
  }

  markDismissed(clusterId: string, p: { now: number; cooldownUntil: number }): void {
    dbRun(
      this.db,
      `UPDATE tribal_clusters SET status = 'dismissed', cooldown_until = ? WHERE cluster_id = ?`,
      [p.cooldownUntil, clusterId],
    );
  }

  markCaptured(
    clusterId: string,
    p: { now: number; pageRef: string; cooldownUntil: number },
  ): void {
    dbRun(
      this.db,
      `UPDATE tribal_clusters SET status = 'captured', captured_page_ref = ?, cooldown_until = ? WHERE cluster_id = ?`,
      [p.pageRef, p.cooldownUntil, clusterId],
    );
  }

  private getOrThrow(clusterId: string): TribalCluster {
    const c = this.get(clusterId);
    if (c === undefined) {
      throw new Error(`tribal cluster ${clusterId} vanished after write`);
    }
    return c;
  }
}
