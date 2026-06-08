import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";
import type { PolicySource } from "./types.ts";

export interface PersistedPolicy {
  readonly toml: string;
  readonly sig: string;
  readonly org: string;
  readonly version: number;
  readonly issuedAt?: string;
  readonly fetchedAt: number;
  readonly source: PolicySource;
}

/** The `org_policy_state.source` column is plain TEXT (no CHECK). Validate against the
 * allowed set before trusting it; fail closed to "none" (ungoverned) on any unexpected value. */
function toPolicySource(value: string): PolicySource {
  return value === "anchor" || value === "peer" || value === "none" ? value : "none";
}

interface PolicyRow {
  toml: string;
  sig: string;
  org: string;
  version: number;
  issued_at: string | null;
  fetched_at: number;
  source: string;
}

export class PolicyStore {
  constructor(private readonly db: Database) {}

  persist(p: PersistedPolicy): void {
    dbRun(
      this.db,
      `INSERT INTO org_policy_state (id, toml, sig, org, version, issued_at, fetched_at, source)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         toml = excluded.toml, sig = excluded.sig, org = excluded.org,
         version = excluded.version, issued_at = excluded.issued_at,
         fetched_at = excluded.fetched_at, source = excluded.source`,
      [p.toml, p.sig, p.org, p.version, p.issuedAt ?? null, p.fetchedAt, p.source],
    );
  }

  load(): PersistedPolicy | undefined {
    const row = this.db
      .query(
        "SELECT toml, sig, org, version, issued_at, fetched_at, source FROM org_policy_state WHERE id = 1",
      )
      .get() as PolicyRow | null;
    if (row === null) {
      return undefined;
    }
    return {
      toml: row.toml,
      sig: row.sig,
      org: row.org,
      version: row.version,
      ...(row.issued_at === null ? {} : { issuedAt: row.issued_at }),
      fetchedAt: row.fetched_at,
      source: toPolicySource(row.source),
    };
  }

  pinAnchorPubkey(pubkey: string, source: "pairing" | "manual", nowMs: number): void {
    dbRun(
      this.db,
      `INSERT INTO policy_anchor_pin (id, pubkey, pinned_at, source) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET pubkey = excluded.pubkey, pinned_at = excluded.pinned_at, source = excluded.source`,
      [pubkey, nowMs, source],
    );
  }

  getAnchorPubkey(): string | undefined {
    const row = this.db.query("SELECT pubkey FROM policy_anchor_pin WHERE id = 1").get() as {
      pubkey: string;
    } | null;
    return row?.pubkey;
  }
}
