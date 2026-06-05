// identity-store.ts
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { BindingSource, IdentitySession, ScimUser } from "./types.ts";

interface SessionRow {
  issuer: string;
  external_id: string;
  email: string | null;
  validated_at: number;
  expires_at: number;
  status: string;
}
interface ScimRow {
  external_id: string;
  user_name: string | null;
  email: string | null;
  active: number;
  attrs_json: string;
}

/** Maps a raw `status` column to the closed status union (unknown values default to active). */
function normalizeSessionStatus(raw: string): IdentitySession["status"] {
  if (raw === "deprovisioned") return "deprovisioned";
  if (raw === "expired") return "expired";
  return "active";
}

export class IdentityStore {
  constructor(private readonly db: Database) {}

  upsertSession(s: IdentitySession & { claimsJson?: string }): void {
    dbRun(
      this.db,
      `INSERT INTO identity_session (issuer, external_id, email, claims_json, validated_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(issuer) DO UPDATE SET
         external_id = excluded.external_id, email = excluded.email, claims_json = excluded.claims_json,
         validated_at = excluded.validated_at, expires_at = excluded.expires_at, status = excluded.status`,
      [s.issuer, s.externalId, s.email, s.claimsJson ?? "{}", s.validatedAt, s.expiresAt, s.status],
    );
  }

  getSession(issuer: string): IdentitySession | undefined {
    const row = this.db
      .query<SessionRow, [string]>(`SELECT * FROM identity_session WHERE issuer = ?`)
      .get(issuer);
    if (row === null || row === undefined) return undefined;
    return {
      issuer: row.issuer,
      externalId: row.external_id,
      email: row.email,
      validatedAt: row.validated_at,
      expiresAt: row.expires_at,
      status: normalizeSessionStatus(row.status),
    };
  }

  setSessionStatus(issuer: string, status: IdentitySession["status"]): void {
    dbRun(this.db, `UPDATE identity_session SET status = ? WHERE issuer = ?`, [status, issuer]);
  }

  clearSession(issuer: string): void {
    dbRun(this.db, `DELETE FROM identity_session WHERE issuer = ?`, [issuer]);
  }

  upsertScimUser(u: ScimUser, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO scim_user (external_id, user_name, email, active, attrs_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(external_id) DO UPDATE SET
         user_name = excluded.user_name, email = excluded.email, active = excluded.active,
         attrs_json = excluded.attrs_json, updated_at = excluded.updated_at`,
      [u.externalId, u.userName, u.email, u.active ? 1 : 0, JSON.stringify(u.attrs), nowMs, nowMs],
    );
  }

  setScimActive(externalId: string, active: boolean, nowMs: number): void {
    dbRun(this.db, `UPDATE scim_user SET active = ?, updated_at = ? WHERE external_id = ?`, [
      active ? 1 : 0,
      nowMs,
      externalId,
    ]);
  }

  getScimUser(externalId: string): ScimUser | undefined {
    const row = this.db
      .query<ScimRow, [string]>(`SELECT * FROM scim_user WHERE external_id = ?`)
      .get(externalId);
    if (row === null || row === undefined) return undefined;
    let attrs: Record<string, unknown> = {};
    try {
      const p: unknown = JSON.parse(row.attrs_json);
      if (p !== null && typeof p === "object" && !Array.isArray(p))
        attrs = p as Record<string, unknown>;
    } catch {
      /* corrupt attrs default to {} */
    }
    return {
      externalId: row.external_id,
      userName: row.user_name,
      email: row.email,
      active: row.active === 1,
      attrs,
    };
  }

  findScimByEmail(email: string): ScimUser | undefined {
    const row = this.db
      .query<{ external_id: string }, [string]>(`SELECT external_id FROM scim_user WHERE email = ?`)
      .get(email);
    return row === null || row === undefined ? undefined : this.getScimUser(row.external_id);
  }

  listScimUsers(): ScimUser[] {
    const ids = this.db
      .query<{ external_id: string }, []>(
        `SELECT external_id FROM scim_user ORDER BY external_id ASC`,
      )
      .all();
    return ids
      .map((r) => this.getScimUser(r.external_id))
      .filter((u): u is ScimUser => u !== undefined);
  }

  bind(externalId: string, peerId: string, by: BindingSource, nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO identity_binding (external_id, peer_id, bound_at, bound_by, revoked_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(external_id, peer_id) DO UPDATE SET bound_at = excluded.bound_at, bound_by = excluded.bound_by, revoked_at = NULL`,
      [externalId, peerId, nowMs, by],
    );
  }

  activePeerIdsFor(externalId: string): string[] {
    return this.db
      .query<{ peer_id: string }, [string]>(
        `SELECT peer_id FROM identity_binding WHERE external_id = ? AND revoked_at IS NULL ORDER BY peer_id ASC`,
      )
      .all(externalId)
      .map((r) => r.peer_id);
  }

  revokeBinding(peerId: string, nowMs: number): void {
    dbRun(
      this.db,
      `UPDATE identity_binding SET revoked_at = ? WHERE peer_id = ? AND revoked_at IS NULL`,
      [nowMs, peerId],
    );
  }
}
