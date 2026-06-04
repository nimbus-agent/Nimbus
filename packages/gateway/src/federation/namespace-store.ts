import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type {
  FederationRole,
  NamespaceDefinition,
  NamespaceFilter,
  NamespaceGrant,
} from "./types.ts";

interface NsRow {
  namespace_id: string;
  name: string;
  owner_self: number;
  created_at: number;
}
interface FilterRow {
  filter_kind: "service" | "type" | "tag";
  filter_value: string;
}
interface GrantRow {
  namespace_id: string;
  peer_id: string;
  role: FederationRole;
  standing_consent: number;
  granted_at: number;
  revoked_at: number | null;
}

/** Deterministic namespace id derived from the name (no Math.random / Date.now in module code). */
function namespaceIdFor(name: string): string {
  return `ns:${name}`;
}

export class NamespaceStore {
  constructor(private readonly db: Database) {}

  publish(
    name: string,
    filters: readonly NamespaceFilter[],
    nowMs = Date.now(),
  ): NamespaceDefinition {
    const id = namespaceIdFor(name);
    this.db.transaction(() => {
      // UPSERT: re-publishing the same name must NOT abort on the unique constraint — it should
      // refresh the filter set below. `namespace_id` is derived from `name`, so the conflicting
      // row's name already equals excluded.name; the SET is an intentional no-op that merely
      // turns the INSERT into an idempotent upsert so the filter DELETE+INSERT can proceed.
      dbRun(
        this.db,
        `INSERT INTO federation_namespaces (namespace_id, name, owner_self, created_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(namespace_id) DO UPDATE SET name = excluded.name`,
        [id, name, nowMs],
      );
      dbRun(this.db, `DELETE FROM federation_namespace_filters WHERE namespace_id = ?`, [id]);
      for (const f of filters) {
        dbRun(
          this.db,
          `INSERT OR IGNORE INTO federation_namespace_filters (namespace_id, filter_kind, filter_value)
           VALUES (?, ?, ?)`,
          [id, f.kind, f.value],
        );
      }
    })();
    const def = this.getByName(name);
    if (def === undefined) throw new Error("federation: namespace publish failed");
    return def;
  }

  getByName(name: string): NamespaceDefinition | undefined {
    const row = this.db
      .query<NsRow, [string]>(`SELECT * FROM federation_namespaces WHERE name = ?`)
      .get(name);
    if (row === null || row === undefined) return undefined;
    return {
      namespaceId: row.namespace_id,
      name: row.name,
      ownerSelf: row.owner_self === 1,
      createdAt: row.created_at,
      filters: this.filtersFor(row.namespace_id),
    };
  }

  private filtersFor(namespaceId: string): NamespaceFilter[] {
    const rows = this.db
      .query<FilterRow, [string]>(
        `SELECT filter_kind, filter_value FROM federation_namespace_filters
         WHERE namespace_id = ? ORDER BY rowid ASC`,
      )
      .all(namespaceId);
    return rows.map((r) => ({ kind: r.filter_kind, value: r.filter_value }));
  }

  declaredTypes(name: string): string[] {
    return (this.getByName(name)?.filters ?? [])
      .filter((f) => f.kind === "type")
      .map((f) => f.value);
  }

  declaredServices(name: string): string[] {
    return (this.getByName(name)?.filters ?? [])
      .filter((f) => f.kind === "service")
      .map((f) => f.value);
  }

  grant(
    name: string,
    peerId: string,
    role: FederationRole,
    standingConsent: boolean,
    nowMs = Date.now(),
  ): void {
    const id = namespaceIdFor(name);
    // Re-granting refreshes granted_at: each grant() call records the latest grant decision
    // (the prior epoch is not preserved). granted_at is informational for Slice 1 — the gate
    // authorizes on role + standing_consent, not on this timestamp.
    dbRun(
      this.db,
      `INSERT INTO federation_grants (namespace_id, peer_id, role, standing_consent, granted_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(namespace_id, peer_id) DO UPDATE SET
         role = excluded.role,
         standing_consent = excluded.standing_consent,
         granted_at = excluded.granted_at,
         revoked_at = NULL`,
      [id, peerId, role, standingConsent ? 1 : 0, nowMs],
    );
  }

  revoke(name: string, peerId: string, nowMs = Date.now()): void {
    const id = namespaceIdFor(name);
    dbRun(
      this.db,
      `UPDATE federation_grants SET revoked_at = ? WHERE namespace_id = ? AND peer_id = ? AND revoked_at IS NULL`,
      [nowMs, id, peerId],
    );
  }

  /** Live-checked: returns the grant ONLY if it exists and is not revoked. */
  getActiveGrant(name: string, peerId: string): NamespaceGrant | undefined {
    const id = namespaceIdFor(name);
    const row = this.db
      .query<GrantRow, [string, string]>(
        `SELECT * FROM federation_grants WHERE namespace_id = ? AND peer_id = ? AND revoked_at IS NULL`,
      )
      .get(id, peerId);
    if (row === null || row === undefined) return undefined;
    return {
      namespaceId: row.namespace_id,
      peerId: row.peer_id,
      role: row.role,
      standingConsent: row.standing_consent === 1,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    };
  }
}
