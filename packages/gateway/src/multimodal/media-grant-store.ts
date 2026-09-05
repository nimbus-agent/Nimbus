/**
 * The ONLY module that names the `media_grant` table (static rule D27(b), spec § 18.7).
 *
 * Confining table access here is what stops a caller synthesising a grant or reading around the
 * active-row filter: every read goes through `hasActiveGrant`/`listActiveGrants`, both of which
 * apply `revoked_at IS NULL` themselves rather than trusting a caller to remember it.
 *
 * I9-safe throughout: every value is bound, every identifier is a literal in this source.
 * I14/D12: writes go through `dbRun`, never a bare `.run()`.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dbRun } from "../db/write.ts";

export interface MediaGrant {
  readonly id: string;
  readonly itemId: string;
  readonly modality: "image" | "av";
  readonly modelVendor: string;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/**
 * Thrown for a grant this RELEASE will not write, as distinct from one the schema rejects.
 * Named so the CLI can render the bound rather than surfacing a SQLite constraint error.
 */
export class MediaGrantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaGrantRefusedError";
  }
}

type GrantRow = {
  id: string;
  item_id: string;
  modality: string;
  model_vendor: string;
  granted_at: number;
  revoked_at: number | null;
};

function toGrant(r: GrantRow): MediaGrant {
  return {
    id: r.id,
    itemId: r.item_id,
    // The CHECK constraint guarantees this, so the narrow restates what the schema proved.
    modality: r.modality === "av" ? "av" : "image",
    modelVendor: r.model_vendor,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
  };
}

function findActive(
  db: Database,
  itemId: string,
  modality: "image" | "av",
  modelVendor: string,
): MediaGrant | undefined {
  const row = db
    .query<GrantRow, [string, string, string]>(
      `SELECT id, item_id, modality, model_vendor, granted_at, revoked_at
         FROM media_grant
        WHERE item_id = ? AND modality = ? AND model_vendor = ? AND revoked_at IS NULL`,
    )
    .get(itemId, modality, modelVendor);
  return row === null ? undefined : toGrant(row);
}

/**
 * Idempotent by lookup-then-insert rather than `INSERT OR IGNORE`: the batch preview must
 * distinguish "granted now" from "already granted" (§ 19.6), and `OR IGNORE` succeeds silently
 * with nothing to distinguish on. `alreadyActive` is that distinction.
 */
export function createGrant(
  db: Database,
  args: {
    readonly itemId: string;
    readonly modality: "image" | "av";
    readonly modelVendor: string;
    readonly nowMs: number;
  },
): { id: string; alreadyActive: boolean } {
  if (args.modality === "av") {
    throw new MediaGrantRefusedError(
      "remote understanding is images-only in this release: an audio/video artifact cannot be granted. " +
        "Its transcript is produced locally by whisper-cli and never leaves the machine.",
    );
  }
  const existing = findActive(db, args.itemId, args.modality, args.modelVendor);
  if (existing !== undefined) return { id: existing.id, alreadyActive: true };

  const id = randomUUID();
  dbRun(
    db,
    `INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, args.itemId, args.modality, args.modelVendor, args.nowMs],
  );
  return { id, alreadyActive: false };
}

/** Returns the number of grants revoked. Omitting `modelVendor` revokes every vendor's grant. */
export function revokeGrant(
  db: Database,
  args: { readonly itemId: string; readonly modelVendor?: string; readonly nowMs: number },
): number {
  if (args.modelVendor === undefined) {
    return dbRun(
      db,
      "UPDATE media_grant SET revoked_at = ? WHERE item_id = ? AND revoked_at IS NULL",
      [args.nowMs, args.itemId],
    ).changes;
  }
  return dbRun(
    db,
    `UPDATE media_grant SET revoked_at = ?
      WHERE item_id = ? AND model_vendor = ? AND revoked_at IS NULL`,
    [args.nowMs, args.itemId, args.modelVendor],
  ).changes;
}

export function listActiveGrants(db: Database): MediaGrant[] {
  return db
    .query<GrantRow, []>(
      `SELECT id, item_id, modality, model_vendor, granted_at, revoked_at
         FROM media_grant WHERE revoked_at IS NULL ORDER BY granted_at, id`,
    )
    .all()
    .map(toGrant);
}

export function hasActiveGrant(
  db: Database,
  args: {
    readonly itemId: string;
    readonly modality: "image" | "av";
    readonly modelVendor: string;
  },
): boolean {
  return findActive(db, args.itemId, args.modality, args.modelVendor) !== undefined;
}

/**
 * Spec § 19.7. REVOKES rather than deletes — § 18.3's argument for the partial index is that
 * revocation is an append-only audit trail, and a pruner that deleted rows would be the one
 * caller allowed to rewrite history.
 *
 * STATED BOUND: an item that leaves the index transiently (a reindex that drops and re-adds rows)
 * loses its grant, and the owner must grant again. That is the safe direction of the failure, and
 * it is the same premise `pruneOrphanedUnderstandings` has run on since PR 3.
 */
export function revokeOrphanedGrants(db: Database, nowMs: number): number {
  return dbRun(
    db,
    `UPDATE media_grant
        SET revoked_at = ?
      WHERE revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM item AS src WHERE src.id = media_grant.item_id)`,
    [nowMs],
  ).changes;
}
