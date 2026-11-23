import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { publisherKeyFingerprint, RegistryError } from "@nimbus-dev/registry-format";
import { listExtensions } from "../../automation/extension-store.ts";
import {
  type ConnectorRequirementDeps,
  type ConnectorRequirementStatus,
  connectorRequirementStatuses,
} from "../connector-requirements.ts";
import { type ResolvedNode, registryNameOf } from "../dependency-types.ts";
import {
  type PlannedPackage,
  planPermissionsUnion,
  renderInstallPlan,
  withNeedsBlock,
} from "../install-plan-text.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import { getRegistry } from "../registry/registry-store.ts";
import { keyChangeNote } from "../trust/publisher-key-decision.ts";
import {
  publisherBadgeText,
  type VerifiedPublisher,
  verifiedPublisherFor,
} from "../trust/verified-publisher.ts";
import { decodeBase64, verifyManifestSignature } from "../verify-signature.ts";
import type { ExtensionInstallApprovalRequest, InstallFromLocalOptions } from "./types.ts";

const NO_PERMISSIONS: ExtensionManifest["permissions"] = {
  network: [],
  filesystem: { read: [], write: [] },
};

/** The manifest of an installed (reused) package, read from disk; undefined when unreadable. */
function installedManifestOf(db: Database, id: string): ExtensionManifest | undefined {
  const row = listExtensions(db).find((r) => r.id === id);
  const path = row === undefined ? undefined : resolveExtensionManifestPath(row.install_path);
  if (path === undefined) return undefined;
  try {
    return parseExtensionManifestJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function publisherOf(
  manifest: ExtensionManifest | undefined,
): { id: string; fingerprint: string } | null {
  return manifest?.publisher === undefined
    ? null
    : { id: manifest.publisher.id, fingerprint: publisherKeyFingerprint(manifest.publisher.key) };
}

/** What the owner is shown about one plan node, beyond its id, version, edges and registry. */
function plannedDetails(
  options: InstallFromLocalOptions,
  node: ResolvedNode,
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
): Pick<
  PlannedPackage,
  "publisher" | "publisherBadge" | "publisherChange" | "publisherChangeNote" | "permissions"
> {
  if (node.id === manifest.id) {
    return {
      publisher: publisherOf(manifest),
      ...(rootBadge === null ? {} : { publisherBadge: publisherBadgeText(rootBadge) }),
      permissions: manifest.permissions,
    };
  }
  const verified = node.newlyInstalled
    ? options.registryPlan?.resolver.verified(node.id, node.version)
    : undefined;
  if (node.newlyInstalled && verified === undefined) {
    // The approval must never understate: a package about to be installed is shown from its
    // verified manifest, or the install is refused here, before the owner is asked.
    throw new RegistryError(
      "ERR_REGISTRY_INSTALL_REFUSED",
      `${node.id}@${node.version} would be installed but has no verified manifest to show in the approval`,
    );
  }
  if (verified === undefined) {
    const installed = installedManifestOf(options.db, node.id);
    return {
      publisher: publisherOf(installed),
      permissions: installed?.permissions ?? NO_PERMISSIONS,
    };
  }
  const pc = verified.publisherChange;
  return {
    publisher:
      verified.manifest.publisher === undefined
        ? null
        : {
            id: verified.manifest.publisher.id,
            fingerprint: publisherKeyFingerprint(verified.publisherKey),
          },
    ...(verified.verifiedPublisher === null
      ? {}
      : { publisherBadge: publisherBadgeText(verified.verifiedPublisher) }),
    ...(pc === null
      ? {}
      : {
          publisherChange: { ...pc.change, via: pc.via },
          publisherChangeNote: keyChangeNote(pc.change, pc.via),
        }),
    permissions: verified.manifest.permissions,
  };
}

function registryUrlOf(options: InstallFromLocalOptions, source: string): string | null {
  return (
    options.registryPlan?.resolver.registryUrl(source) ??
    getRegistry(options.db, registryNameOf(source))?.url ??
    null
  );
}

/** Every plan node as the owner is shown it, in plan (topological) order. */
function buildPlannedPackages(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
): PlannedPackage[] {
  return plan.nodes.map((node) => ({
    id: node.id,
    version: node.version,
    requiredBy: plan.nodes.flatMap((from) =>
      from.deps.filter((d) => d.id === node.id).map((d) => ({ from: from.id, range: d.range })),
    ),
    registry: node.source === null ? null : registryNameOf(node.source),
    registryUrl: node.source === null ? null : registryUrlOf(options, node.source),
    ...plannedDetails(options, node, manifest, rootBadge),
    newlyInstalled: node.newlyInstalled,
  }));
}

/**
 * The plan fields of the request, or none: a single-package install (no dependency at all, and no
 * package from another registry than the root's) carries no `plan`, and a `planText` only when it
 * requires a connector (the `Needs:` block alone).
 */
function planFields(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
  rootBadge: VerifiedPublisher | null,
  requirements: readonly ConnectorRequirementStatus[] | undefined,
): Pick<ExtensionInstallApprovalRequest, "plan" | "planPermissions" | "planText"> {
  const registryOf = (n: ResolvedNode): string | null =>
    n.source === null ? null : registryNameOf(n.source);
  const rootNode = plan.nodes.find((n) => n.id === manifest.id);
  const rootRegistry = rootNode === undefined ? null : registryOf(rootNode);
  const crossRegistry = plan.nodes.some((n) => {
    const r = registryOf(n);
    return r !== null && r !== rootRegistry;
  });
  if (plan.nodes.length <= 1 && !crossRegistry) {
    const needsOnly = withNeedsBlock(undefined, requirements);
    return needsOnly === undefined ? {} : { planText: needsOnly };
  }
  const packages = buildPlannedPackages(options, plan, manifest, rootBadge);
  const planPermissions = planPermissionsUnion(packages);
  return {
    plan: packages,
    planPermissions,
    planText: withNeedsBlock(renderInstallPlan(packages, planPermissions), requirements),
  };
}

/**
 * Every package this plan newly installs (the root included), with the manifest the approval is
 * built from and the registry root its row will record, so requirement status can see a
 * continuity-bound owner the plan is about to install (it has no run grant yet).
 */
function pendingInstallsOf(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
): NonNullable<ConnectorRequirementDeps["pendingInstalls"]> {
  const out: Array<{ manifest: ExtensionManifest; sourceRootFingerprint: string | undefined }> = [];
  for (const n of plan.nodes) {
    if (!n.newlyInstalled) continue;
    if (n.id === manifest.id) {
      out.push({ manifest, sourceRootFingerprint: options.rootFingerprint });
      continue;
    }
    const verified = options.registryPlan?.resolver.verified(n.id, n.version);
    if (verified === undefined) continue;
    out.push({ manifest: verified.manifest, sourceRootFingerprint: verified.reg.rootFingerprint });
  }
  return out;
}

/**
 * The connector requirements of the root and every newly installed dependency, each read from the
 * manifest the approval is built from (the root's, and the dependency's VERIFIED registry
 * manifest), before anything is staged. Undefined without a Vault (nothing is computed), and
 * undefined when the computation fails: the approval then carries no requirements and no `Needs:`
 * block, and the install goes on — requirement status never refuses an install.
 */
export async function planConnectorRequirements(
  options: InstallFromLocalOptions,
  plan: { nodes: readonly ResolvedNode[] },
  manifest: ExtensionManifest,
): Promise<ConnectorRequirementStatus[] | undefined> {
  const vault = options.vault;
  if (vault === undefined) return undefined;
  const compute = options.requirementStatuses ?? connectorRequirementStatuses;
  const manifests = [
    manifest,
    ...plan.nodes
      .filter((n) => n.newlyInstalled && n.id !== manifest.id)
      .map((n) => options.registryPlan?.resolver.verified(n.id, n.version)?.manifest),
  ];
  const required = manifests.flatMap((m) =>
    m?.requires === undefined ? [] : [{ extensionId: m.id, connectors: m.requires.connectors }],
  );
  try {
    return await compute(
      {
        db: options.db,
        vault,
        ...(options.continuityTable === undefined
          ? {}
          : { continuityTable: options.continuityTable }),
        pendingInstalls: pendingInstallsOf(options, plan, manifest),
      },
      required,
    );
  } catch {
    return undefined;
  }
}

export function buildInstallApprovalRequest(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  plan: { nodes: readonly ResolvedNode[] },
  sourcePath: string,
  badge: VerifiedPublisher | null,
  requirements: readonly ConnectorRequirementStatus[] | undefined,
): ExtensionInstallApprovalRequest {
  const others = plan.nodes
    .filter((n) => n.newlyInstalled && n.id !== manifest.id)
    .map((n) => ({ id: n.id, version: n.version }));
  return {
    id: manifest.id,
    version: manifest.version,
    sourcePath,
    publisher: publisherOf(manifest),
    permissions: manifest.permissions,
    installs: [{ id: manifest.id, version: manifest.version }, ...others],
    ...(options.sourceRegistry !== undefined && { sourceRegistry: options.sourceRegistry }),
    ...(options.rootFingerprint !== undefined && { rootFingerprint: options.rootFingerprint }),
    verifiedPublisher: badge,
    publisherBadge: publisherBadgeText(badge),
    ...planFields(options, plan, manifest, badge, requirements),
    ...(requirements === undefined ? {} : { connectorRequirements: requirements }),
  };
}

/**
 * The verified publisher (R6) to show in the install prompt — for a registry install only. The I16 check of the installed copy
 * runs only after approval, so the badge is asked only once the source manifest's signature has
 * been verified here with the key it declares — never on a claim alone.
 */
export async function installPromptBadge(
  options: InstallFromLocalOptions,
  manifest: ExtensionManifest,
  manifestText: string,
): Promise<VerifiedPublisher | null> {
  const publisher = manifest.publisher;
  // R6 as amended 2026-10-27: a local-path install's manifest signature does not bind its entry
  // file (a registry install's index hashes do), so only a registry install is ever badged.
  if (publisher === undefined || options.sourceRegistry === undefined) return null;
  try {
    const raw = JSON.parse(manifestText) as Record<string, unknown>;
    await verifyManifestSignature(raw, decodeBase64(publisher.key));
  } catch {
    return null;
  }
  return verifiedPublisherFor(options.db, {
    publisherId: publisher.id,
    keyFingerprint: publisherKeyFingerprint(publisher.key),
    source:
      options.sourceRegistry !== undefined && options.rootFingerprint !== undefined
        ? { registry: options.sourceRegistry, rootFingerprint: options.rootFingerprint }
        : null,
  });
}
