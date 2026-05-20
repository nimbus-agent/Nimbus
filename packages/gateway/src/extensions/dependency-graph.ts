import semver from "semver";
import { DependencyConflictError, OfflineDependencyResolutionError } from "./dependency-errors.ts";
import type {
  DependencyConstraint,
  ExtensionManifestForSolver,
  InstallPlan,
  RegistryFetcher,
  ResolveClosureOptions,
  ResolvedDep,
  ResolvedNode,
} from "./dependency-types.ts";

type Ranges = Map<string, DependencyConstraint[]>;
type Pinned = Map<string, string>;
type ManifestCache = Map<string, ExtensionManifestForSolver>; // key = `${id}@${version}`

/** Treat any non-typed thrown error from the fetcher as a network failure. */
function isRegistryUnreachable(e: unknown): boolean {
  if (e instanceof OfflineDependencyResolutionError) return true;
  if (e instanceof DependencyConflictError) return false;
  return e instanceof Error;
}

/**
 * Recursive DFS with per-frame state clones (see spec §2.2). The `ancestors` Set is
 * the active recursive call stack — distinct from `pinned` (resolved nodes) so a
 * diamond DAG never false-positives as a cycle.
 */
export async function resolveClosure(
  root: ExtensionManifestForSolver,
  fetcher: RegistryFetcher,
  opts: ResolveClosureOptions,
): Promise<InstallPlan> {
  // Seed range constraints from every installed extension's dependsOn map.
  const initialRanges: Ranges = new Map();
  for (const [dependent, depMap] of opts.activeConstraints) {
    for (const [depId, range] of depMap) {
      const list = initialRanges.get(depId) ?? [];
      list.push({ from: dependent, range });
      initialRanges.set(depId, list);
    }
  }
  // Seed pinned with currently-installed versions.
  const initialPinned: Pinned = new Map(opts.installed);
  // ancestors is shared mutably across the DFS (add on entry, delete on exit).
  const ancestors = new Set<string>();
  const manifestCache: ManifestCache = new Map();
  // Final node map keyed by id (single entry per id post-resolution).
  const resolved: Map<string, ResolvedNode> = new Map();
  const initialInstalled = new Map(opts.installed);

  await visit(
    root,
    initialPinned,
    initialRanges,
    ancestors,
    fetcher,
    manifestCache,
    resolved,
    initialInstalled,
  );

  return { nodes: topoSort(resolved) };
}

async function visit(
  current: ExtensionManifestForSolver,
  pinned: Pinned,
  ranges: Ranges,
  ancestors: Set<string>,
  fetcher: RegistryFetcher,
  manifestCache: ManifestCache,
  resolved: Map<string, ResolvedNode>,
  initialInstalled: ReadonlyMap<string, string>,
): Promise<void> {
  ancestors.add(current.id);
  pinned.set(current.id, current.version);

  try {
    const deps: ResolvedDep[] = [];
    const depEntries = Object.entries(current.dependsOn ?? {});

    for (const [depId, range] of depEntries) {
      if (typeof range !== "string" || !semver.validRange(range)) {
        throw new DependencyConflictError({
          kind: "range_invalid",
          id: depId,
          constraints: [{ from: current.id, range }],
        });
      }

      if (ancestors.has(depId)) {
        const chain = [...ancestors, depId];
        throw new DependencyConflictError({ kind: "cycle", id: depId, chain });
      }

      // Append constraint with provenance.
      const constraintList = ranges.get(depId) ?? [];
      constraintList.push({ from: current.id, range });
      ranges.set(depId, constraintList);

      // Pick a candidate version.
      const installed = pinned.get(depId);
      let candidate: string | undefined;
      if (installed && constraintList.every((c) => semver.satisfies(installed, c.range))) {
        candidate = installed;
      } else {
        let versions: readonly string[];
        try {
          versions = await fetcher.listVersions(depId);
        } catch (e) {
          if (isRegistryUnreachable(e)) {
            throw new OfflineDependencyResolutionError({ missingId: depId, parent: current.id });
          }
          throw e;
        }
        // Highest-satisfying first.
        candidate =
          semver.maxSatisfying([...versions], constraintList.map((c) => c.range).join(" ")) ??
          undefined;
        if (!candidate) {
          throw new DependencyConflictError({
            kind: "unsatisfiable",
            id: depId,
            constraints: [...constraintList],
            // Review-fix #4: pass through the registry's published versions so the CLI/HITL
            // renderer can show "available: x, y, z" without re-querying.
            availableVersions: [...versions],
          });
        }
      }

      // Fetch dep manifest (cache hit if same id@version was already pulled).
      const cacheKey = `${depId}@${candidate}`;
      let depManifest = manifestCache.get(cacheKey);
      if (!depManifest) {
        try {
          depManifest = await fetcher.fetchManifest(depId, candidate);
        } catch (e) {
          if (isRegistryUnreachable(e)) {
            throw new OfflineDependencyResolutionError({ missingId: depId, parent: current.id });
          }
          throw e;
        }
        manifestCache.set(cacheKey, depManifest);
      }

      deps.push({ id: depId, range, resolvedVersion: candidate });

      // Recurse — pinned & ranges shared by reference; per-frame clone only on backtrack.
      if (!resolved.has(depId)) {
        await visit(
          depManifest,
          pinned,
          ranges,
          ancestors,
          fetcher,
          manifestCache,
          resolved,
          initialInstalled,
        );
      }
    }

    const installedVersion = initialInstalled.get(current.id);
    resolved.set(current.id, {
      id: current.id,
      version: current.version,
      newlyInstalled: installedVersion !== current.version,
      deps,
    });
  } finally {
    ancestors.delete(current.id);
  }
}

/**
 * Kahn's algorithm — emit leaf-first.
 *
 * Perf note: `queue.sort()` on every iteration is O(V log V) per step → O(V² log V) overall.
 * With the closure bound of ~15 nodes in practice (and the per-PR-spec out-of-scope
 * statement that solver inputs stay small), this is microscopic. If the ecosystem ever
 * needs closures with hundreds of nodes, swap the array+sort for a binary-heap priority
 * queue keyed on id — the algorithm is otherwise unchanged.
 */
function topoSort(resolved: Map<string, ResolvedNode>): readonly ResolvedNode[] {
  const inDegree: Map<string, number> = new Map();
  const reverseEdges: Map<string, string[]> = new Map(); // depId → list of dependents
  for (const node of resolved.values()) {
    inDegree.set(node.id, node.deps.length);
    for (const dep of node.deps) {
      const list = reverseEdges.get(dep.id) ?? [];
      list.push(node.id);
      reverseEdges.set(dep.id, list);
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  // Stable order: sort the initial leaves alphabetically.
  queue.sort();
  const out: ResolvedNode[] = [];
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const node = resolved.get(id);
    if (!node) continue;
    out.push(node);
    const dependents = reverseEdges.get(id) ?? [];
    for (const dep of dependents) {
      const next = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, next);
      if (next === 0) queue.push(dep);
    }
    queue.sort();
  }
  return out;
}
