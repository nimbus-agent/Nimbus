/**
 * The `generated_tool` (V61) repository — spec § 4.
 *
 * This table governs EXISTENCE, never CONTENT: a row here is the durable record that the LOCAL
 * owner approved persisting this tool, so it survives a gateway restart. It is deliberately not
 * where correctness lives — `artifact_json` plus `signature` is what proves the persisted bytes
 * are the exact ones approved, and that verification happens elsewhere (Task 4's load path). A
 * `saved/<toolId>` directory on disk with no row here is an orphan and gets swept, never adopted,
 * because a valid signature proves an artifact was approved ONCE, not that it is approved NOW.
 *
 * `pubkey` is stored per row (rather than read from current Vault state at load time) so that a
 * Vault key rotation reports as the disclosed `pubkey_rotated` reason instead of masquerading as
 * tamper (`signature_mismatch`) — the row remembers which key actually signed it.
 *
 * I14/D12: every write goes through `dbRun`, never a bare `.run()`. I9-safe throughout: every
 * value is a bound parameter: no identifier is ever built from caller input.
 */
import type { Database } from "bun:sqlite";
import { dbRun } from "../db/write.ts";

/**
 * Why a saved tool is not currently loadable, distinguishing tamper from mere drift:
 *
 * - `signature_mismatch` — the signature does not verify over `artifact_json`'s bytes. The bytes
 *   were altered after approval (or never matched it).
 * - `signature_missing` — no signature is present to verify at all.
 * - `artifact_missing` — the row exists but the artifact it should describe cannot be found.
 * - `pubkey_rotated` — the signature was valid under the pubkey stored on this row, but that key
 *   is no longer the Vault's current signing key. Not tamper: the owner rotated keys and this
 *   tool predates the rotation.
 * - `pubkey_unavailable` — the Vault pubkey needed to verify could not be read at all.
 * - `schema_invalid` — the signature verifies fine (the bytes are exactly what was approved), but
 *   parsing the artifact against this build's expected shape fails. A valid signature proves the
 *   bytes were not tampered with; it proves nothing about their *shape* — an artifact written by a
 *   different build of Nimbus can verify perfectly and still be missing a field this build
 *   requires. Signature verification is not schema validation.
 *
 * `body_missing` is deliberately NOT a member: the on-disk script is derived and re-emitted at
 * spawn time, so its absence on disk is not itself a failure state.
 */
export type SavedToolDisabledReason =
  | "signature_mismatch"
  | "signature_missing"
  | "artifact_missing"
  | "pubkey_rotated"
  | "pubkey_unavailable"
  | "schema_invalid";

export interface SavedToolRow {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  readonly artifactJson: string;
  readonly artifactDigest: string;
  readonly signature: string;
  readonly pubkey: string;
  readonly approvedAt: number;
  readonly savedAt: number;
  readonly lastLoadedAt: number | null;
  readonly disabledReason: SavedToolDisabledReason | null;
}

type GeneratedToolDbRow = {
  tool_id: string;
  tool_name: string;
  description: string;
  artifact_json: string;
  artifact_digest: string;
  signature: string;
  pubkey: string;
  approved_at: number;
  saved_at: number;
  last_loaded_at: number | null;
  disabled_reason: string | null;
};

/** The CHECK-free `disabled_reason` column is TEXT; narrow it rather than trust it verbatim. */
function toDisabledReason(value: string | null): SavedToolDisabledReason | null {
  switch (value) {
    case "signature_mismatch":
    case "signature_missing":
    case "artifact_missing":
    case "pubkey_rotated":
    case "pubkey_unavailable":
    case "schema_invalid":
      return value;
    default:
      return null;
  }
}

function toSavedToolRow(r: GeneratedToolDbRow): SavedToolRow {
  return {
    toolId: r.tool_id,
    toolName: r.tool_name,
    description: r.description,
    artifactJson: r.artifact_json,
    artifactDigest: r.artifact_digest,
    signature: r.signature,
    pubkey: r.pubkey,
    approvedAt: r.approved_at,
    savedAt: r.saved_at,
    lastLoadedAt: r.last_loaded_at,
    disabledReason: toDisabledReason(r.disabled_reason),
  };
}

const SELECT_COLS = `SELECT tool_id, tool_name, description, artifact_json, artifact_digest,
                             signature, pubkey, approved_at, saved_at, last_loaded_at,
                             disabled_reason
                        FROM generated_tool`;

export function insertSavedTool(db: Database, row: SavedToolRow): void {
  dbRun(
    db,
    `INSERT INTO generated_tool
       (tool_id, tool_name, description, artifact_json, artifact_digest, signature, pubkey,
        approved_at, saved_at, last_loaded_at, disabled_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.toolId,
      row.toolName,
      row.description,
      row.artifactJson,
      row.artifactDigest,
      row.signature,
      row.pubkey,
      row.approvedAt,
      row.savedAt,
      row.lastLoadedAt,
      row.disabledReason,
    ],
  );
}

export function listSavedTools(db: Database): SavedToolRow[] {
  return db
    .query<GeneratedToolDbRow, []>(`${SELECT_COLS} ORDER BY tool_id`)
    .all()
    .map(toSavedToolRow);
}

export function getSavedTool(db: Database, toolId: string): SavedToolRow | null {
  const row = db
    .query<GeneratedToolDbRow, [string]>(`${SELECT_COLS} WHERE tool_id = ?`)
    .get(toolId);
  return row === null ? null : toSavedToolRow(row);
}

export function deleteSavedTool(db: Database, toolId: string): void {
  dbRun(db, "DELETE FROM generated_tool WHERE tool_id = ?", [toolId]);
}

export function setSavedToolDisabled(
  db: Database,
  toolId: string,
  reason: SavedToolDisabledReason | null,
): void {
  dbRun(db, "UPDATE generated_tool SET disabled_reason = ? WHERE tool_id = ?", [reason, toolId]);
}

export function touchSavedToolLoaded(db: Database, toolId: string, now: number): void {
  dbRun(db, "UPDATE generated_tool SET last_loaded_at = ? WHERE tool_id = ?", [now, toolId]);
}

/**
 * Repairs the row's cached copy of the signed bytes and their digest — the two columns a
 * re-canonicalisation (e.g. a portable-manifest format change) can legitimately need to rewrite —
 * without touching `signature`/`pubkey`/`approved_at`, which describe an approval event that must
 * not be quietly re-dated by a cache repair.
 */
export function repairSavedToolCache(
  db: Database,
  toolId: string,
  cache: { artifactJson: string; artifactDigest: string },
): void {
  dbRun(db, "UPDATE generated_tool SET artifact_json = ?, artifact_digest = ? WHERE tool_id = ?", [
    cache.artifactJson,
    cache.artifactDigest,
    toolId,
  ]);
}
