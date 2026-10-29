import type { DependencySpec, RegistryIndex } from "@nimbus-dev/registry-format";
import type { ConnectorRequirementStatus } from "./connector-requirements.ts";
import type { DependencyConflict, InstallPlan } from "./dependency-types.ts";
import type { PlannedPackage } from "./install-plan-text.ts";
import type { RegistryDependencyResolver } from "./registry/registry-dependency-fetcher.ts";

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
  /** The connectors the installed manifest requires (absent when it declares none). */
  requires?: { readonly connectors: readonly string[] };
}

/**
 * A package an update installs alongside the new version: a dependency the new version declares
 * that is not installed. Field names follow `PlannedPackage` (and stay clear of the audit redactor).
 */
export interface AddedPackage {
  readonly id: string;
  readonly version: string;
  /** The registry NAME it is fetched from (I44: the update's source, or a registry the owner added). */
  readonly registry: string;
  readonly registryUrl: string | null;
}

/**
 * Why an update does not fit, one line each (`reason`). A solver conflict keeps its structured
 * fields; a registry refusal (a dependency naming a registry the owner has not added, a key
 * mismatch, a takedown, …) carries its code; `offline` means a registry could not be reached, so
 * the update is neither planned nor refused yet.
 */
export type UpdateConflict =
  | (DependencyConflict & { readonly reason: string })
  | { readonly kind: "registry"; readonly code: string; readonly reason: string }
  | {
      readonly kind: "offline";
      readonly id: string;
      readonly parent: string;
      readonly reason: string;
    };

/**
 * An update solved through the registry-scoped resolver (`planUpdate`): the resolver holds the
 * verified manifests the solve used (what the apply stages), the plan has the root at the new
 * version, and `addedPackages` are its newly installed dependencies.
 */
export interface UpdatePlanContext {
  /** The source registry's index, verified this tick, so the plan need not read it again. */
  readonly index?: RegistryIndex;
  /** Aborts the plan's registry requests (the daemon's stop). */
  readonly signal?: AbortSignal;
}

export interface UpdatePlan {
  readonly resolver: RegistryDependencyResolver;
  readonly plan: InstallPlan;
  readonly addedPackages: readonly AddedPackage[];
}

/**
 * A package an update adds, as the owner is shown it in the `extension.autoUpdate` approval: the
 * install plan's block (`PlannedPackage`, from the resolver's verified manifest) and its kind, so a
 * starter pack is never offered a run approval.
 */
export type ShownAddedPackage = PlannedPackage & { readonly kind: "extension" | "starter-pack" };

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
  /** The fingerprint of the publisher key the index names for this version. */
  publisherKeyFingerprint?: string;
  /** The publisher id the index names (identity, not a badge: the badge is never cached, R7). */
  publisherId?: string;
  /** Set when that key differs from every key the Vault trusts (fingerprints only). */
  publisherKeyChange?: { from: readonly string[]; to: string; via?: "rotation" | "nimbus" };
  /** Set by `extension.update --accept-publisher-key`: the owner accepted this exact key. */
  acceptedPublisherKey?: string;
  detectedAt: number;
  conflicts?: readonly UpdateConflict[];
  /**
   * Set ONLY when the update was planned: the dependencies it would install (possibly none). Absent
   * means "not planned" (a conflict says why, or the signature/key status stops it), never "adds
   * nothing".
   */
  addedPackages?: readonly AddedPackage[];
  /** The connectors the new version requires that the installed one does not. */
  addedRequirements?: readonly string[];
  /**
   * The new version's declared dependencies (full specs, registry kept), from the manifest whose
   * hash is `manifestHash`; absent when it declares none. The approval re-plans from these, and the
   * apply re-verifies that same manifest hash.
   */
  dependsOn?: Readonly<Record<string, DependencySpec>>;
  /** Set when the new version's verified manifest is a starter pack: it has no code to run. */
  toStarterPack?: true;
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
  | "extract_failed"
  | "downgrade_unavailable"
  /** I48: the target version's key is revoked or the version is taken down (re-checked at apply). */
  | "trust_blocked"
  /** The update's dependencies cannot be planned (a conflict, an unadded registry, …): refused before the prompt. */
  | "update_conflicts";

/** Refused before the prompt, rejected at it, or — after approval — the phase the apply failed in. */
export type UpdateRejectReason =
  | "cache_miss"
  | "publisher_key_conflict"
  | "same_version"
  | "update_in_flight"
  | "user_rejected"
  | AutoUpdateFailPhase
  | "internal_error";

export interface UpdateApplyResult {
  applied: boolean;
  reason?: UpdateRejectReason;
  hint?: string;
  jobId?: string;
  /** An applied update: the packages its approved plan added (set only when there are any). */
  addedPackages?: ReadonlyArray<{
    readonly id: string;
    readonly version: string;
    readonly registry: string | null;
    readonly kind: "extension" | "starter-pack";
  }>;
  /** An applied update: the connector requirements its approval showed (set only when there are any). */
  connectorRequirements?: readonly ConnectorRequirementStatus[];
}
