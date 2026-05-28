export interface ResolvedDep {
  readonly id: string;
  readonly range: string;
  readonly resolvedVersion: string;
}

export interface ResolvedNode {
  readonly id: string;
  readonly version: string;
  readonly newlyInstalled: boolean;
  readonly deps: readonly ResolvedDep[];
}

export interface InstallPlan {
  readonly nodes: readonly ResolvedNode[];
}

export interface RegistryFetcher {
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

export interface ExtensionManifestForSolver {
  readonly id: string;
  readonly version: string;
  readonly dependsOn?: Readonly<Record<string, string>>;
}

export interface ResolveClosureOptions {
  readonly installed: ReadonlyMap<string, string>;
  readonly activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
