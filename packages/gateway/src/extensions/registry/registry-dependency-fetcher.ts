/**
 * The registry side of a dependency solve (I44). A registry install resolves its missing
 * dependencies in two phases, and this module is both:
 *
 * 1. BEFORE approval, `fetcher` answers the solver: each dependency's registry is the one
 *    `resolveDependencyRegistry` names (only among registries the owner added), each registry's
 *    index is read once through the pinned-root, anti-rollback `fetchVerifiedIndex`, and each
 *    dependency manifest is hash-checked against that index, I16-signature-verified with the
 *    index's publisher key, checked against the Vault's publisher keys, against I48 blocks and
 *    against what this gateway can install. Only a manifest that passed all of that reaches the
 *    solver, and it is recorded (`verified`) so the owner is asked about exactly what was solved.
 * 2. AFTER approval, `stage` fetches each node's package and stages it through the root install's
 *    own `stageVerifiedPackage` (package hash, extraction, packaged-manifest hash, entry hash).
 *
 * Nothing is read until the solver asks about a dependency, so a package with no `dependsOn` makes
 * no request here. A dependency already installed from the same source is read from disk (it was
 * I16-verified at install and is re-verified at every startup), never fetched again.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type DependencySpec,
  publisherKeyFingerprint,
  type RegistryChannel,
  RegistryError,
  type RegistryExtensionEntry,
  type RegistryIndex,
  type RegistryVersionEntry,
} from "@nimbus-dev/registry-format";
import { type ExtensionRow, listExtensions } from "../../automation/extension-store.ts";
import { sha256HexEqualConstantTime } from "../../util/timing-safe-compare.ts";
import {
  type ExtensionManifestForSolver,
  type RegistryFetcher,
  registryNameOf,
  type SourceKey,
  sourceKey,
} from "../dependency-types.ts";
import {
  type ExtensionManifest,
  parseExtensionManifestJson,
  resolveExtensionManifestPath,
} from "../manifest.ts";
import {
  type KeyChange,
  type KeyVia,
  publisherKeyConflict,
  publisherKeyDecision,
} from "../trust/publisher-key-decision.ts";
import { assertNotBlocked, type BlockSubject, blocksFor } from "../trust/trust-blocks.ts";
import { type VerifiedPublisher, verifiedPublisherFor } from "../trust/verified-publisher.ts";
import { builtinRegistryOf, resolveRegistry } from "./builtin-registry.ts";
import { resolveDependencyRegistry } from "./dependency-registry.ts";
import type { InstallFromRegistryDeps } from "./install-from-registry.ts";
import { fetchVerifiedIndex, type RegistryFetchDeps } from "./registry-fetch.ts";
import {
  fetchRegistryManifest,
  sha256Hex,
  verifyRegistryManifestSignature,
} from "./registry-manifest.ts";
import { stageVerifiedPackage } from "./registry-package-stage.ts";
import type { RegistryRow } from "./registry-store.ts";

/** A dependency manifest phase 1 fetched and fully verified; its package is not fetched yet. */
export interface VerifiedDependency {
  readonly id: string;
  readonly version: string;
  readonly reg: RegistryRow;
  readonly vEntry: RegistryVersionEntry;
  readonly manifest: ExtensionManifest;
  /** base64, as the index lists it */
  readonly publisherKey: string;
  readonly publisherChange: { readonly change: KeyChange; readonly via: KeyVia } | null;
  readonly verifiedPublisher: VerifiedPublisher | null;
}

export interface StagedDependency extends VerifiedDependency {
  readonly sourceRoot: string;
}

export interface RegistryDependencyResolver {
  readonly fetcher: RegistryFetcher;
  readonly rootSource: SourceKey;
  /** Phase-1 results, by `${id}@${version}`: exactly the manifests the solve used. */
  verified(id: string, version: string): VerifiedDependency | undefined;
  /** The URL of a registry this resolution met (the root's, or one a dependency named); else null. */
  registryUrl(source: SourceKey): string | null;
  /** Phase 2 (after approval): stage each node's package under `intoDir/<n>/`; throws on the first failure. */
  stage(
    nodes: readonly { id: string; version: string }[],
    intoDir: string,
  ): Promise<readonly StagedDependency[]>;
}

function keyOf(reg: RegistryRow): SourceKey {
  return sourceKey(reg.name, reg.rootFingerprint);
}

/** The I48 subject of `id@version` as `reg`'s index lists it. */
function subjectOf(
  reg: RegistryRow,
  entry: RegistryExtensionEntry,
  id: string,
  version: string,
): BlockSubject {
  return {
    extensionId: id,
    version,
    publisherId: entry.publisher.id,
    keyFingerprint: publisherKeyFingerprint(entry.publisher.key),
    source: { registry: reg.name, rootFingerprint: reg.rootFingerprint },
  };
}

function forSolver(m: ExtensionManifest): ExtensionManifestForSolver {
  return {
    id: m.id,
    version: m.version,
    ...(m.dependsOn === undefined ? {} : { dependsOn: m.dependsOn }),
  };
}

function rowSource(row: ExtensionRow): SourceKey | null {
  return row.source_registry != null && row.source_root_fingerprint != null
    ? sourceKey(row.source_registry, row.source_root_fingerprint)
    : null;
}

/** The installed manifest of `row`, refused unless its bytes are still the ones that were installed. */
function readInstalledManifest(row: ExtensionRow): ExtensionManifest {
  const refuse = (why: string): RegistryError =>
    new RegistryError("ERR_REGISTRY_MANIFEST_INVALID", `installed ${row.id}@${row.version} ${why}`);
  const path = resolveExtensionManifestPath(row.install_path);
  if (path === undefined || !existsSync(path)) throw refuse("has no manifest");
  const bytes = readFileSync(path);
  if (!sha256HexEqualConstantTime(sha256Hex(bytes), row.manifest_hash)) {
    throw refuse("no longer matches the manifest that was installed; reinstall it");
  }
  try {
    return parseExtensionManifestJson(bytes.toString("utf8"));
  } catch (e) {
    throw refuse(`has an unreadable manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function createRegistryDependencyResolver(
  deps: InstallFromRegistryDeps,
  root: { reg: RegistryRow; channel: RegistryChannel; index?: RegistryIndex },
): RegistryDependencyResolver {
  const fetchDeps: RegistryFetchDeps = { ...deps.fetch, db: deps.db };
  const rootSource = keyOf(root.reg);
  const registries = new Map<SourceKey, RegistryRow>([[rootSource, root.reg]]);
  // One verified read per registry per resolver; the root's registry reuses the root's read.
  const indexes = new Map<SourceKey, Promise<RegistryIndex>>();
  if (root.index !== undefined) indexes.set(rootSource, Promise.resolve(root.index));
  const verifiedById = new Map<string, VerifiedDependency>();
  const channels: readonly string[] = root.channel === "beta" ? ["stable", "beta"] : ["stable"];

  /** The registry a source names: one this resolver met, or an installed node's recorded source. */
  function registryOf(source: SourceKey): RegistryRow {
    const known = registries.get(source);
    if (known !== undefined) return known;
    const name = registryNameOf(source);
    const reg = resolveRegistry(deps.db, name, builtinRegistryOf(fetchDeps));
    if (reg === undefined || keyOf(reg) !== source) {
      throw new RegistryError(
        "ERR_DEPENDENCY_SOURCE_MISMATCH",
        `registry "${name}" was removed or re-pinned since an installed extension came from it`,
      );
    }
    registries.set(source, reg);
    return reg;
  }

  function indexOf(source: SourceKey): Promise<RegistryIndex> {
    let read = indexes.get(source);
    if (read === undefined) {
      read = fetchVerifiedIndex(fetchDeps, registryOf(source));
      indexes.set(source, read);
    }
    return read;
  }

  /** `id@version` installed from `source`, read from disk; undefined when it is not installed so. */
  function installedManifest(
    id: string,
    version: string,
    source: SourceKey | null,
  ): ExtensionManifestForSolver | undefined {
    const row = listExtensions(deps.db).find((r) => r.id === id);
    if (row?.version !== version || rowSource(row) !== source) return undefined;
    return forSolver(readInstalledManifest(row));
  }

  const fetcher: RegistryFetcher = {
    targetSource(parentSource: SourceKey | null, depId: string, spec: DependencySpec) {
      // A node from a local folder names no registry its dependencies could come from.
      if (parentSource === null) return null;
      const reg = resolveDependencyRegistry(fetchDeps, registryOf(parentSource), depId, spec);
      const key = keyOf(reg);
      if (!registries.has(key)) registries.set(key, reg);
      return key;
    },

    async listVersions(id: string, source: SourceKey | null) {
      if (source === null) return [];
      const reg = registryOf(source);
      const entry = (await indexOf(source)).extensions[id];
      if (entry === undefined) return [];
      // On the root's channel, minus every version I48 blocks (A10): a taken-down newest version
      // leaves the clean one below it to satisfy the range.
      return Object.entries(entry.versions)
        .filter(([, v]) => channels.includes(v.channel))
        .map(([version]) => version)
        .filter((version) => blocksFor(deps.db, subjectOf(reg, entry, id, version)).length === 0)
        .sort((a, b) => Bun.semver.order(a, b));
    },

    async fetchManifest(id: string, version: string, source: SourceKey | null) {
      const installed = installedManifest(id, version, source);
      if (installed !== undefined) return installed;
      if (source === null) {
        throw new RegistryError(
          "ERR_DEPENDENCY_SOURCE_MISMATCH",
          `${id}@${version} is not installed and names no registry to fetch it from`,
        );
      }
      const reg = registryOf(source);
      const entry = (await indexOf(source)).extensions[id];
      const vEntry = entry?.versions[version];
      if (entry === undefined || vEntry === undefined) {
        throw new RegistryError(
          "ERR_REGISTRY_VERSION_NOT_FOUND",
          `"${id}" has no version ${version} in ${reg.name}`,
        );
      }
      const subject = subjectOf(reg, entry, id, version);
      // I48 before any manifest request, as for the root.
      assertNotBlocked(deps.db, subject);
      const fetched = await fetchRegistryManifest(fetchDeps, reg, entry, id, version, vEntry);
      await verifyRegistryManifestSignature(fetched, id, version);
      // A dependency's key is never owner-accepted: only the rotation chain or Nimbus vouches.
      const decision = await publisherKeyDecision(deps, {
        publisherId: entry.publisher.id,
        key: entry.publisher.key,
        source: subject.source,
      });
      if (!decision.ok) throw publisherKeyConflict(entry.publisher.id, decision);
      verifiedById.set(`${id}@${version}`, {
        id,
        version,
        reg,
        vEntry,
        manifest: fetched.manifest,
        publisherKey: entry.publisher.key,
        publisherChange:
          decision.change === null ? null : { change: decision.change, via: decision.via },
        verifiedPublisher: verifiedPublisherFor(deps.db, subject),
      });
      return forSolver(fetched.manifest);
    },
  };

  return {
    fetcher,
    rootSource,
    verified: (id, version) => verifiedById.get(`${id}@${version}`),
    registryUrl: (source) => registries.get(source)?.url ?? null,
    async stage(nodes, intoDir) {
      const staged: StagedDependency[] = [];
      for (const [n, node] of nodes.entries()) {
        const v = verifiedById.get(`${node.id}@${node.version}`);
        if (v === undefined) {
          throw new RegistryError(
            "ERR_REGISTRY_INSTALL_REFUSED",
            `${node.id}@${node.version} was not verified by this dependency resolution`,
          );
        }
        // Sequential by design: one package at a time, and the first refusal stops the rest.
        const into = join(intoDir, String(n));
        const args = [fetchDeps, v.reg, v.id, v.version, v.vEntry, v.manifest, into] as const;
        const { sourceRoot } = await stageVerifiedPackage(...args); // NOSONAR S9382: the first refusal must stop every later fetch
        staged.push({ ...v, sourceRoot });
      }
      return staged;
    },
  };
}
