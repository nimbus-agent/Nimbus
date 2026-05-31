import type { DependencyConflict } from "./dependency-types.ts";

export type UpdateChannel = "stable" | "beta";

export type VerificationStatus = "verified" | "needs_sync" | "signature_failed";
export interface PermissionDiff {
  network: { added: string[]; removed: string[] };
  filesystem: {
    read: { added: string[]; removed: string[] };
    write: { added: string[]; removed: string[] };
  };
}

export interface AvailableUpdate {
  id: string;
  displayName: string;
  fromVersion: string;
  toVersion: string;
  channel: UpdateChannel;
  changelog: string;
  publisherStatus: "verified" | "unverified";
  manifestHash: string;
  signatureB64: string;
  entryHash: string;
  tarballUrl: string;
  tarballSizeBytes?: number;
  permissionDiff: PermissionDiff;
  verificationStatus: VerificationStatus;
  detectedAt: number;
  conflicts?: readonly DependencyConflict[];
}

export const ACTION_TYPE_AUTO_UPDATE = "extension.autoUpdate" as const;
export const ACTION_TYPE_DOWNGRADE = "extension.downgrade" as const;

export type AutoUpdateFailPhase =
  | "sha256_mismatch"
  | "signature_failed"
  | "swap_failed"
  | "download_failed"
  | "extract_failed";

export type UpdateRejectReason =
  | "cache_miss"
  | "publisher_key_missing"
  | "signature_failed"
  | "same_version"
  | "downgrade_unavailable"
  | "update_in_flight"
  | "user_rejected"
  | "internal_error";

export interface UpdateApplyResult {
  applied: boolean;
  reason?: UpdateRejectReason;
  hint?: string;
  jobId?: string;
}
