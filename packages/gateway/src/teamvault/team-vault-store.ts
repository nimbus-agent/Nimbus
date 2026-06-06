import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

export interface TeamVaultEntry {
  readonly entry: string;
  readonly service: string;
  readonly createdAt: number;
  readonly createdBy: string;
}

interface EntryRow {
  entry: string;
  service: string;
  created_at: number;
  created_by: string;
}

export class TeamVaultStore {
  constructor(private readonly db: Database) {}

  createEntry(entry: string, service: string, createdBy: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `INSERT INTO team_vault_entries (entry, service, created_at, created_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(entry) DO UPDATE SET service = excluded.service`,
      [entry, service, nowMs, createdBy],
    );
  }

  getEntry(entry: string): TeamVaultEntry | undefined {
    const row = this.db
      .query<EntryRow, [string]>(`SELECT * FROM team_vault_entries WHERE entry = ?`)
      .get(entry);
    if (row === null || row === undefined) return undefined;
    return {
      entry: row.entry,
      service: row.service,
      createdAt: row.created_at,
      createdBy: row.created_by,
    };
  }

  listEntries(): TeamVaultEntry[] {
    const rows = this.db
      .query<EntryRow, []>(`SELECT * FROM team_vault_entries ORDER BY entry ASC`)
      .all();
    return rows.map((r) => ({
      entry: r.entry,
      service: r.service,
      createdAt: r.created_at,
      createdBy: r.created_by,
    }));
  }

  grant(entry: string, peerId: string, toolId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `INSERT INTO team_vault_grants (entry, peer_id, tool_id, mode, granted_at, revoked_at)
       VALUES (?, ?, ?, 'use', ?, NULL)
       ON CONFLICT(entry, peer_id, tool_id) DO UPDATE SET granted_at = excluded.granted_at, revoked_at = NULL`,
      [entry, peerId, toolId, nowMs],
    );
  }

  revoke(entry: string, peerId: string, toolId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `UPDATE team_vault_grants SET revoked_at = ?
       WHERE entry = ? AND peer_id = ? AND tool_id = ? AND revoked_at IS NULL`,
      [nowMs, entry, peerId, toolId],
    );
  }

  /** Live-checked on every call (no cache): an active grant must exist for the exact tuple. (D11) */
  checkGrant(entry: string, peerId: string, toolId: string): boolean {
    const row = this.db
      .query<{ one: number }, [string, string, string]>(
        `SELECT 1 AS one FROM team_vault_grants
         WHERE entry = ? AND peer_id = ? AND tool_id = ? AND revoked_at IS NULL`,
      )
      .get(entry, peerId, toolId);
    return row !== null && row !== undefined;
  }
}
