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
type ManifestCache = Map<string, ExtensionManifestForSolver>;
function isRegistryUnreachable(e: unknown): boolean {
  if (e instanceof OfflineDependencyResolutionError) return true;
  if (e instanceof DependencyConflictError) return false;
  return e instanceof Error;
}

export async function resolveClosure(
  root: ExtensionManifestForSolver,
  fetcher: RegistryFetcher,
  opts: ResolveClosureOptions,
): Promise<InstallPlan> {
  const initialRanges: Ranges = new Map();
  for (const [dependent, depMap] of opts.activeConstraints) {
    for (const [depId, range] of depMap) {
      const list = initialRanges.get(depId) ?? [];
      list.push({ from: dependent, range });
      initialRanges.set(depId, list);
    }
  }
  const initialPinned: Pinned = new Map(opts.installed);
  const ancestors = new Set<string>();
  const manifestCache: ManifestCache = new Map();
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

async function resolveDepCandidate(
  depId: string,
  parentId: string,
  pinned: Pinned,
  constraintList: DependencyConstraint[],
  fetcher: RegistryFetcher,
): Promise<string> {
  const installed = pinned.get(depId);
  if (installed && constraintList.every((c) => semver.satisfies(installed, c.range))) {
    return installed;
  }
  let versions: readonly string[];
  try {
    versions = await fetcher.listVersions(depId);
  } catch (e) {
    if (isRegistryUnreachable(e)) {
      throw new OfflineDependencyResolutionError({ missingId: depId, parent: parentId });
    }
    throw e;
  }
  const candidate =
    semver.maxSatisfying([...versions], constraintList.map((c) => c.range).join(" ")) ?? undefined;
  if (!candidate) {
    throw new DependencyConflictError({
      kind: "unsatisfiable",
      id: depId,
      constraints: [...constraintList],
      availableVersions: [...versions],
    });
  }
  return candidate;
}

async function loadDepManifest(
  depId: string,
  parentId: string,
  candidate: string,
  fetcher: RegistryFetcher,
  manifestCache: ManifestCache,
): Promise<ExtensionManifestForSolver> {
  const cacheKey = `${depId}@${candidate}`;
  const cached = manifestCache.get(cacheKey);
  if (cached) return cached;
  let depManifest: ExtensionManifestForSolver;
  try {
    depManifest = await fetcher.fetchManifest(depId, candidate);
  } catch (e) {
    if (isRegistryUnreachable(e)) {
      throw new OfflineDependencyResolutionError({ missingId: depId, parent: parentId });
    }
    throw e;
  }
  manifestCache.set(cacheKey, depManifest);
  return depManifest;
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

      const constraintList = ranges.get(depId) ?? [];
      constraintList.push({ from: current.id, range });
      ranges.set(depId, constraintList);

      const candidate = await resolveDepCandidate(
        depId,
        current.id,
        pinned,
        constraintList,
        fetcher,
      );

      const depManifest = await loadDepManifest(
        depId,
        current.id,
        candidate,
        fetcher,
        manifestCache,
      );

      deps.push({ id: depId, range, resolvedVersion: candidate });

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

function buildTopoGraph(resolved: Map<string, ResolvedNode>): {
  inDegree: Map<string, number>;
  reverseEdges: Map<string, string[]>;
} {
  const inDegree: Map<string, number> = new Map();
  const reverseEdges: Map<string, string[]> = new Map();
  for (const node of resolved.values()) {
    inDegree.set(node.id, node.deps.length);
    for (const dep of node.deps) {
      const list = reverseEdges.get(dep.id) ?? [];
      list.push(node.id);
      reverseEdges.set(dep.id, list);
    }
  }
  return { inDegree, reverseEdges };
}

function topoSort(resolved: Map<string, ResolvedNode>): readonly ResolvedNode[] {
  const { inDegree, reverseEdges } = buildTopoGraph(resolved);
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  queue.sort((a, b) => a.localeCompare(b));
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
    queue.sort((a, b) => a.localeCompare(b));
  }
  return out;
}
