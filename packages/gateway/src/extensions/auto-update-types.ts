import type { DependencyConflict } from "./dependency-types.ts";

export type UpdateChannel = "stable" | "beta";

/** The slice of an installed extension's manifest the update path reads. */
export interface InstalledExtensionManifestSlice {
  id: string;
  version: string;
  name?: string;
  updateChannel: UpdateChannel;
  publisher?: { id: string; key: string };
  signature?: string;
  permissions: {
    network: string[];
    filesystem: { read: string[]; write: string[] };
  };
  dependsOn?: Readonly<Record<string, string>>;
}

/**
 * `publisher_key_conflict`: the source registry's signed index names a publisher key that differs
 * from the one the Vault already holds for that publisher id. Never applied (spec § 8.6 step 4).
 */
export type VerificationStatus = "verified" | "signature_failed" | "publisher_key_conflict";
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
  /** SHA-256 of the entry FILE (what the row stores and startup verification re-measures). */
  entryHash: string;
  /** SHA-256 of the package the index signed — download integrity only, never stored on the row. */
  packageSha256: string;
  packageSizeBytes: number;
  /** The registry the extension was installed from, the only one its updates come from. */
  sourceRegistry: string;
  /** That registry's pinned root-key fingerprint when the update was detected. */
  rootFingerprint: string;
  /** The package's path inside the registry, as the signed index lists it. */
  packagePath: string;
  permissionDiff: PermissionDiff;
  verificationStatus: VerificationStatus;
  detectedAt: number;
  conflicts?: readonly DependencyConflict[];
}

export const ACTION_TYPE_AUTO_UPDATE = "extension.autoUpdate" as const;
export const ACTION_TYPE_DOWNGRADE = "extension.downgrade" as const;

export type AutoUpdateFailPhase =
  | "source_registry_changed"
  | "sha256_mismatch"
  | "package_hash_mismatch"
  | "package_hash_unreadable"
  | "signature_failed"
  | "swap_failed"
  | "download_failed"
  | "extract_failed";

export type UpdateRejectReason =
  | "cache_miss"
  | "publisher_key_conflict"
  | "source_registry_changed"
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
