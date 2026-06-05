import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { FetchLike } from "./types.ts";

/** A public JWK (RSA). Stored verbatim; non-secret. */
export interface PublicJwk {
  readonly kid: string;
  readonly kty: string;
  readonly n?: string;
  readonly e?: string;
  readonly alg?: string;
  readonly [k: string]: unknown;
}

interface CacheRow {
  key_json: string;
  fetched_at: number;
}

export class JwksCache {
  constructor(
    private readonly db: Database,
    private readonly fetchLike: FetchLike,
    private readonly opts: { maxAgeSeconds: number },
  ) {}

  /** Returns the JWK for `kid`, fetching when absent or stale. Fails CLOSED (undefined) if offline. */
  async getKey(
    issuer: string,
    jwksUri: string,
    kid: string,
    nowMs: number,
  ): Promise<PublicJwk | undefined> {
    const fresh = this.readFresh(issuer, kid, nowMs);
    if (fresh !== undefined) return fresh;
    // miss or stale → try one refetch
    const ok = await this.refetch(issuer, jwksUri, nowMs);
    if (!ok) return undefined;
    return this.readFresh(issuer, kid, nowMs);
  }

  private readFresh(issuer: string, kid: string, nowMs: number): PublicJwk | undefined {
    const row = this.db
      .query<CacheRow, [string, string]>(
        `SELECT key_json, fetched_at FROM oidc_jwks_cache WHERE issuer = ? AND kid = ?`,
      )
      .get(issuer, kid);
    if (row === null || row === undefined) return undefined;
    if (nowMs - row.fetched_at > this.opts.maxAgeSeconds * 1000) return undefined; // stale → force refetch
    try {
      return JSON.parse(row.key_json) as PublicJwk;
    } catch {
      return undefined;
    }
  }

  private async refetch(issuer: string, jwksUri: string, nowMs: number): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetchLike(jwksUri);
    } catch {
      return false; // offline
    }
    if (!res.ok) return false;
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    if (body === null || typeof body !== "object") return false;
    const keys = (body as Record<string, unknown>)["keys"];
    if (!Array.isArray(keys)) return false;
    for (const k of keys) {
      if (k === null || typeof k !== "object") continue;
      const kid = (k as Record<string, unknown>)["kid"];
      if (typeof kid !== "string") continue;
      dbRun(
        this.db,
        `INSERT INTO oidc_jwks_cache (issuer, kid, key_json, fetched_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(issuer, kid) DO UPDATE SET key_json = excluded.key_json, fetched_at = excluded.fetched_at`,
        [issuer, kid, JSON.stringify(k), nowMs],
      );
    }
    return true;
  }
}
