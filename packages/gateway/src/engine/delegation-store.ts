import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dbRun } from "../db/write.ts";

export type DelegationScopeKind = "action_type" | "service";

export interface DelegationInput {
  readonly delegatePeer: string;
  readonly scopeKind: DelegationScopeKind;
  readonly scopeValue: string;
  readonly expiresAt: number;
  readonly nowMs?: number;
}

export interface Delegation {
  readonly delegationId: string;
  readonly delegatePeer: string;
  readonly scopeKind: DelegationScopeKind;
  readonly scopeValue: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

interface Row {
  delegation_id: string;
  delegate_peer: string;
  scope_kind: DelegationScopeKind;
  scope_value: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * The read seam the executor's I20 gate consults. Implemented by the db-backed
 * `DelegationStore` (federation delegations) and by virtual scope readers (e.g. the ChatOps
 * owner-as-delegate adapter, whose "delegate" is the policy-resolved resource owner).
 */
export interface DelegationReader {
  activeDelegateFor(
    scopeKind: DelegationScopeKind,
    scopeValue: string,
    peerId: string,
    nowMs: number,
  ): boolean;
  activeDelegateePeer(actionType: string, service: string, nowMs: number): string | undefined;
}

export class DelegationStore implements DelegationReader {
  constructor(private readonly db: Database) {}

  create(input: DelegationInput): string {
    const now = input.nowMs ?? Date.now();
    const id = randomUUID();
    dbRun(
      this.db,
      `INSERT INTO hitl_delegations
         (delegation_id, delegate_peer, scope_kind, scope_value, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      [id, input.delegatePeer, input.scopeKind, input.scopeValue, now, input.expiresAt],
    );
    return id;
  }

  revoke(delegationId: string, nowMs = Date.now()): void {
    dbRun(
      this.db,
      `UPDATE hitl_delegations SET revoked_at = ? WHERE delegation_id = ? AND revoked_at IS NULL`,
      [nowMs, delegationId],
    );
  }

  /** Live-checked: is `peerId` an active, in-scope, unexpired delegate for this action? (I20 input) */
  activeDelegateFor(
    scopeKind: DelegationScopeKind,
    scopeValue: string,
    peerId: string,
    nowMs: number,
  ): boolean {
    const row = this.db
      .query<{ one: number }, [DelegationScopeKind, string, string, number]>(
        `SELECT 1 AS one FROM hitl_delegations
         WHERE scope_kind = ? AND scope_value = ? AND delegate_peer = ?
           AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(scopeKind, scopeValue, peerId, nowMs);
    return row !== null && row !== undefined;
  }

  /** The peer a HITL request for this action should route to, if any active delegation matches
   *  either the action-type scope or the service scope. (Both-scopes resolution.) */
  activeDelegateePeer(actionType: string, service: string, nowMs: number): string | undefined {
    const row = this.db
      .query<{ delegate_peer: string }, [number, string, string]>(
        `SELECT delegate_peer FROM hitl_delegations
         WHERE revoked_at IS NULL AND expires_at > ?
           AND ((scope_kind = 'action_type' AND scope_value = ?)
             OR (scope_kind = 'service'     AND scope_value = ?))
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(nowMs, actionType, service);
    return row?.delegate_peer;
  }

  listActive(nowMs: number): Delegation[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT * FROM hitl_delegations WHERE revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
      )
      .all(nowMs);
    return rows.map((r) => ({
      delegationId: r.delegation_id,
      delegatePeer: r.delegate_peer,
      scopeKind: r.scope_kind,
      scopeValue: r.scope_value,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    }));
  }
}
