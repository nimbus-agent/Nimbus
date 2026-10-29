import type { DependencySpec } from "@nimbus-dev/registry-format";

/** Identifies a registry as a source: `${name}#${rootFingerprint}` (a re-pinned registry is a different source). */
export type SourceKey = string;

export function sourceKey(registry: string, rootFingerprint: string): SourceKey {
  return `${registry}#${rootFingerprint}`;
}

/** The registry NAME part of a key (what `ResolvedDep.registry` and `extension_dependency.depends_on_registry` store). */
export function registryNameOf(key: SourceKey): string {
  const hash = key.lastIndexOf("#");
  return hash < 0 ? key : key.slice(0, hash);
}

export interface ResolvedDep {
  readonly id: string;
  readonly range: string;
  readonly resolvedVersion: string;
  /** Registry NAME the edge's target source names; null for a local or backfilled edge. */
  readonly registry: string | null;
}

export interface ResolvedNode {
  readonly id: string;
  readonly version: string;
  readonly newlyInstalled: boolean;
  readonly deps: readonly ResolvedDep[];
  /** Where this node comes from; null for a local folder (or a solve that fetches nothing). */
  readonly source: SourceKey | null;
}

export interface InstallPlan {
  readonly nodes: readonly ResolvedNode[];
}

export interface RegistryFetcher {
  /** Where `depId` (declared by a node whose source is `parentSource`) must come from. null = installed copies only. */
  targetSource(
    parentSource: SourceKey | null,
    depId: string,
    spec: DependencySpec,
  ): SourceKey | null;
  listVersions(id: string, source: SourceKey | null): Promise<readonly string[]>;
  fetchManifest(
    id: string,
    version: string,
    source: SourceKey | null,
  ): Promise<ExtensionManifestForSolver>;
}

export interface ExtensionManifestForSolver {
  readonly id: string;
  readonly version: string;
  readonly dependsOn?: Readonly<Record<string, DependencySpec>>;
}

export interface InstalledForSolver {
  readonly version: string;
  readonly source: SourceKey | null;
}

export interface ResolveClosureOptions {
  readonly installed: ReadonlyMap<string, InstalledForSolver>;
  readonly activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /**
   * Keep solving past a dependency that is refused (a conflict, an unreachable or refusing
   * registry, a trust block): its subtree is skipped, its siblings are still solved, and the solve
   * throws every refusal it met — one alone, or several as a `DependencyConflictsError`. Absent ⇒
   * the first refusal is thrown.
   */
  readonly collectConflicts?: boolean;
}

export interface DependencyConstraint {
  readonly from: string;
  readonly range: string;
}

export interface DependencyConflict {
  readonly kind: "cycle" | "unsatisfiable" | "range_invalid";
  readonly id: string;
  readonly chain?: readonly string[];
  readonly constraints?: readonly DependencyConstraint[];
  readonly availableVersions?: readonly string[];
}
