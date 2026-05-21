import type { DependencyConflict } from "./dependency-types.ts";

/** Update channel literals. `stable` is the default when manifest omits the field. */
export type UpdateChannel = "stable" | "beta";

/** Verification status of a cached bump. */
export type VerificationStatus =
  | "verified" // publisher key in vault; Ed25519 verify passed
  | "needs_sync" // publisher key missing/rotated; user must `nimbus extension sync`
  | "signature_failed"; // verify failed; not actionable

/** Permission delta surfaced in the HITL consent payload. */
export interface PermissionDiff {
  network: { added: string[]; removed: string[] };
  filesystem: {
    read: { added: string[]; removed: string[] };
    write: { added: string[]; removed: string[] };
  };
}

/** One entry in the in-memory `AutoUpdateCache`. Keyed by extension id. */
export interface AvailableUpdate {
  id: string;
  displayName: string;
  fromVersion: string;
  toVersion: string;
  channel: UpdateChannel;
  changelog: string; // plain text, possibly empty
  publisherStatus: "verified" | "unverified";
  manifestHash: string; // hex SHA-256 of canonical manifest
  signatureB64: string; // base64 Ed25519 signature (public bytes)
  entryHash: string; // hex SHA-256 of the new entry tarball
  tarballUrl: string; // resolved download URL
  tarballSizeBytes?: number; // optional, for diag
  permissionDiff: PermissionDiff;
  verificationStatus: VerificationStatus;
  detectedAt: number; // unix ms
  /**
   * Populated when the proposed bump would conflict with constraints contributed
   * by other installed extensions (spec §6). HITL renderers should surface this
   * before the user approves. Absent when the bump is conflict-free or when the
   * solver could not run (offline).
   */
  conflicts?: readonly DependencyConflict[];
}

/** HITL action type literals. NEVER derive from version comparison at the gate; the RPC handler emits these. */
export const ACTION_TYPE_AUTO_UPDATE = "extension.autoUpdate" as const;
export const ACTION_TYPE_DOWNGRADE = "extension.downgrade" as const;

/** Audit phase strings for the `extension.autoUpdate.failed` / `extension.downgrade.failed` rows. */
export type AutoUpdateFailPhase =
  | "sha256_mismatch"
  | "signature_failed"
  | "swap_failed"
  | "download_failed"
  | "extract_failed";

/** Reasons surfaced by `extension.update` RPC handler for non-applied outcomes. */
export type UpdateRejectReason =
  | "cache_miss"
  | "publisher_key_missing"
  | "signature_failed"
  | "same_version"
  | "downgrade_unavailable"
  | "update_in_flight"
  | "user_rejected"
  | "internal_error";

/** IPC response shape for `extension.update`. */
export interface UpdateApplyResult {
  applied: boolean;
  reason?: UpdateRejectReason;
  hint?: string; // user-facing tip (e.g., "run nimbus extension sync")
  jobId?: string; // present when applied=true, for log correlation
}
