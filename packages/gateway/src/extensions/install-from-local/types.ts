import type { Database } from "bun:sqlite";
import type { RegistryChannel, VersionProvenance } from "@nimbus-dev/registry-format";
import type { NimbusVault } from "../../vault/index.ts";
import type {
  ConnectorRequirementStatus,
  ConnectorRequirementStatusesFn,
} from "../connector-requirements.ts";
import type { ContinuityEntry } from "../continuity/continuity-table.ts";
import type { ResolvedNode } from "../dependency-types.ts";
import type { PlannedPackage } from "../install-plan-text.ts";
import type { ExtensionManifest } from "../manifest.ts";
import type { ProvenanceRecheck } from "../registry/provenance-verify.ts";
import type { RegistryDependencyResolver } from "../registry/registry-dependency-fetcher.ts";
import type { VerifiedPublisher } from "../trust/verified-publisher.ts";

export type SingleInstallResult = {
  id: string;
  version: string;
  installPath: string;
  manifestHash: string;
  entryHash: string;
  treeDigest: string;
};

/**
 * What the local owner approves before an install writes anything (Non-Negotiable 2: the consent
 * gate lives in the executor, never in a client prompt). Built from the RESOLVED plan, so the owner
 * sees every package the install will add — dependencies included — and nothing is copied, fetched
 * or rowed for a plan they did not approve.
 *
 * `publisher` is what the manifest CLAIMS. The I16 signature is verified after approval, against
 * the copied bytes, and a failure there still rolls the whole install back — so approval never
 * substitutes for verification, it only precedes it.
 */
export type ExtensionInstallApprovalRequest = {
  readonly id: string;
  readonly version: string;
  readonly sourcePath: string;
  /**
   * `fingerprint` is the first 32 hex chars of SHA-256 over the decoded Ed25519 public key. It is
   * deliberately NOT named `key`: the consent display redacts any payload field whose name
   * contains "key" (`engine/executor/consent-display.ts` `SENSITIVE_PAYLOAD_KEY`), which would hide the one value that
   * lets the owner tell two publishers with the same id apart.
   */
  readonly publisher: { readonly id: string; readonly fingerprint: string } | null;
  readonly permissions: ExtensionManifest["permissions"];
  /** Packages this install adds, root first, then each newly installed dependency. */
  readonly installs: ReadonlyArray<{ readonly id: string; readonly version: string }>;
  /**
   * Set only for a registry install: the registry's name and its pinned root-key fingerprint.
   * Named `rootFingerprint`, never `*Key`, for the same redaction reason as `publisher.fingerprint`.
   */
  readonly sourceRegistry?: string;
  readonly rootFingerprint?: string;
  /**
   * Set when the publisher's key differs from every key the Vault trusts (marketplace trust layer,
   * rotation): fingerprints only, and what vouched for the change. Never `*Key`-named (redaction).
   */
  readonly publisherChange?: {
    readonly from: readonly string[];
    readonly to: string;
    readonly via: string;
  };
  readonly publisherChangeNote?: string;
  /**
   * R6: whether the current Nimbus verification lists the publisher's key — computed only for a
   * manifest whose signature verifies with the key it declares, so a forged manifest claiming a
   * verified publisher's key is shown as unverified. `publisherBadge` is the one sentence to show.
   */
  readonly verifiedPublisher?: VerifiedPublisher | null;
  readonly publisherBadge?: string;
  /**
   * A registry install only: the build provenance the registry verified for this version (trust
   * layer PR 4c), and the one sentence to show; absent when there is none.
   */
  readonly provenance?: VersionProvenance;
  readonly provenanceNote?: string;
  /**
   * A registry install only, with `provenance` and a published Sigstore bundle: what re-verifying
   * that bundle offline against the roots baked into this release found (owner ruling OR-PROV-2:
   * evidence shown in `provenanceNote`, never a decision).
   */
  readonly provenanceRecheck?: ProvenanceRecheck;
  /**
   * Set only when the install adds or reuses more than one package (or a package from another
   * registry than the root's): every plan node, in install (topological) order. A single-package
   * install's request carries none of these three, exactly as before.
   */
  readonly plan?: readonly PlannedPackage[];
  /** The permissions of every newly installed package together, sorted and deduplicated. */
  readonly planPermissions?: ExtensionManifest["permissions"];
  /**
   * The prompt body the executor prints after Details (`withNeedsBlock`): the rendered plan
   * when there is one, then a `Needs:` block when an added package requires a connector. Absent
   * when there is neither.
   */
  readonly planText?: string;
  /**
   * Whether each connector the root and every newly installed dependency require is connected,
   * computed before the owner is asked (nothing is installed yet). Set on every install the gateway
   * has a Vault for (`[]` when nothing is required); absent without one. Install never waits on it.
   */
  readonly connectorRequirements?: readonly ConnectorRequirementStatus[];
};

/** Resolves `true` only when the local owner approved; anything else installs nothing. */
export type ExtensionInstallApprover = (
  request: ExtensionInstallApprovalRequest,
) => Promise<boolean>;

export type InstallExtensionFromLocalResult = SingleInstallResult & {
  installed: readonly ResolvedNode[];
};

/**
 * An explicit install of a package that is already installed only as a dependency (V78
 * `installed_as_dependency = 1`): nothing is fetched, copied or approved, and the only write is the
 * marker, cleared so a later removal of what needed it no longer offers to remove this one.
 */
export type PromotedInstallResult = {
  readonly id: string;
  readonly version: string;
  readonly promoted: true;
  /** The registry and channel the kept copy was installed from; absent for a local copy. */
  readonly sourceRegistry?: string;
  readonly channel?: "stable" | "beta";
};

export type NodeInstallOptions = {
  db: Database;
  extensionsDir: string;
  vault?: NimbusVault;
  publisherKeyPath?: string;
  publisherKey?: Uint8Array;
};

/**
 * One package the plan installer created: its directory from the moment the copy starts (the
 * destination did not exist, so removing it removes only what this install made), and its id once
 * its `extension` row has committed.
 */
export type CreatedPackage = { readonly dir: string; id: string | null };

/** The rollback steps of a failed plan install that themselves failed (see {@link withRollbackFailures}). */
export type RollbackFailure = {
  readonly step: "clearDeps" | "deleteExtension" | "removeDirectory";
  readonly id: string | null;
  readonly dir: string;
  readonly error: unknown;
};

/** The options of {@link installPlanDependencies}: a registry resolution, never a local one. */
export interface PlanDependencyOptions {
  readonly db: Database;
  readonly extensionsDir: string;
  readonly vault?: NimbusVault;
  readonly registryPlan: RegistryPlanHooks;
  /** Where the packages are staged (default `os.tmpdir()`); a test seam. */
  readonly planStagingRoot?: string;
}

/** What {@link installPlanDependencies} installed, in plan order, and how to undo it. */
export interface InstalledPlanDependencies {
  readonly installed: readonly { readonly id: string; readonly version: string }[];
  /** Undoes every package installed here (edges, row, directory), newest first; returns what failed. */
  rollback(): RollbackFailure[];
}

export interface InstallFromLocalOptions {
  db: Database;
  extensionsDir: string;
  sourcePath: string;
  vault?: NimbusVault;
  /** The continuity table requirement status binds legacy connector ids through (default the baked one). */
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  publisherKeyPath?: string;
  /** The publisher's Ed25519 key, supplied by a caller that already established it (a registry install). */
  publisherKey?: Uint8Array;
  /** Shown to the owner in the install prompt; set only by a registry install. */
  sourceRegistry?: string;
  rootFingerprint?: string;
  /**
   * The local owner's approval, asked after the plan resolves and before anything is written. The
   * production IPC path always supplies one (`ipc/automation-rpc/extension-install.ts`); a direct library call
   * without one installs ungated and records the install audit row as `not_required`, never as
   * `approved`.
   */
  approve?: ExtensionInstallApprover;
  /** The path to show the owner when `sourcePath` is an archive's temporary extraction. */
  displaySourcePath?: string;
  /**
   * A registry install only: the dependency resolver the solve reads (phase 1, verified manifests
   * only) and the plan installer stages from (phase 2, after approval), and the channel the owner
   * asked for. Absent, only installed copies satisfy a dependency and nothing is fetched or staged.
   */
  registryPlan?: RegistryPlanHooks;
  /**
   * A registry install only: the entry-file hash the signed index lists for the root. Checked by
   * the plan installer after the root is copied and BEFORE any edge or audit row is recorded, so a
   * mismatch rolls back every package of the plan, dependencies included.
   */
  expectedRootEntryHash?: string;
  /** Where a registry plan's dependencies are staged (default `os.tmpdir()`); a test seam. */
  planStagingRoot?: string;
}

/** What a registry install hands the plan installer (see `InstallFromLocalOptions.registryPlan`). */
export interface RegistryPlanHooks {
  readonly resolver: RegistryDependencyResolver;
  readonly channel: RegistryChannel;
}
