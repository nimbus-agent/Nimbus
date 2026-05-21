/** One dependency edge as resolved by the solver. */
export interface ResolvedDep {
  readonly id: string;
  readonly range: string;
  readonly resolvedVersion: string;
}

/** One node in the resolved install closure. */
export interface ResolvedNode {
  readonly id: string;
  readonly version: string;
  /** Whether this node was already installed at the satisfying version. */
  readonly newlyInstalled: boolean;
  readonly deps: readonly ResolvedDep[];
}

/** Output of the solver — topologically sorted, leaf-first. */
export interface InstallPlan {
  readonly nodes: readonly ResolvedNode[];
}

/** Pluggable registry adapter (production impl is local-first). */
export interface RegistryFetcher {
  listVersions(id: string): Promise<readonly string[]>;
  fetchManifest(id: string, version: string): Promise<ExtensionManifestForSolver>;
}

/** Minimal manifest shape the solver consumes — keeps `dependency-graph.ts` decoupled from the full schema. */
export interface ExtensionManifestForSolver {
  readonly id: string;
  readonly version: string;
  readonly dependsOn?: Readonly<Record<string, string>>;
}

/** Solver inputs other than `root` + `fetcher`. */
export interface ResolveClosureOptions {
  readonly installed: ReadonlyMap<string, string>;
  /** Every installed extension's `dependsOn` map keyed by dependent id — see spec §2.1. */
  readonly activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** Structured shape for a single resolution constraint (used in error payloads). */
export interface DependencyConstraint {
  readonly from: string;
  readonly range: string;
}

/** Structured payload surfaced by `extension.checkForUpdates` / HITL when a bump conflicts. */
export interface DependencyConflict {
  readonly kind: "cycle" | "unsatisfiable" | "range_invalid";
  readonly id: string;
  readonly chain?: readonly string[];
  readonly constraints?: readonly DependencyConstraint[];
  /**
   * For `kind === "unsatisfiable"`: the versions the registry advertised for `id`
   * at the time the solver gave up. Renderers use this to print "available: 1.0.0, 1.5.0"
   * alongside the conflicting ranges — much easier to debug than ranges alone.
   * Empty array means "no versions were listed" (e.g. registry returned `[]`).
   */
  readonly availableVersions?: readonly string[];
}
