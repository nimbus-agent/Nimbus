import { type DependencySpec, RegistryError } from "@nimbus-dev/registry-format";
import semver from "semver";
import {
  DependencyConflictError,
  DependencyConflictsError,
  OfflineDependencyResolutionError,
} from "./dependency-errors.ts";
import {
  type DependencyConstraint,
  type ExtensionManifestForSolver,
  type InstalledForSolver,
  type InstallPlan,
  type RegistryFetcher,
  type ResolveClosureOptions,
  type ResolvedDep,
  type ResolvedNode,
  registryNameOf,
  type SourceKey,
} from "./dependency-types.ts";
import { FETCH_FAILURE_CODES } from "./registry/registry-fetch.ts";
import { TrustBlockError } from "./trust/trust-blocks.ts";

type Ranges = Map<string, DependencyConstraint[]>;
/**
 * One id per plan: an installed copy, or a node chosen earlier in this solve (`planned`). A pinned
 * id is never re-chosen at another version or from another source.
 */
type Pin = {
  readonly version: string;
  readonly source: SourceKey | null;
  readonly planned: boolean;
};
type Pinned = Map<string, Pin>;
type ManifestCache = Map<string, ExtensionManifestForSolver>;
/**
 * Whether a fetcher failure means the registry could not be REACHED. A registry that was reached and
 * refused (a bad signature, a hash mismatch, a key conflict, an unsupported manifest) or a trust
 * block is a refusal in its own right and is never reported as "offline".
 */
function isRegistryUnreachable(e: unknown): boolean {
  if (e instanceof OfflineDependencyResolutionError) return true;
  if (e instanceof DependencyConflictError || e instanceof TrustBlockError) return false;
  if (e instanceof RegistryError) return FETCH_FAILURE_CODES.has(e.code);
  return e instanceof Error;
}

/**
 * Resolves `root`'s dependency closure. `rootSource` is where the root comes from (null for a
 * local folder); each dependency's source is whatever `fetcher.targetSource` names for it, and a
 * node is fetched only from that source.
 */
export async function resolveClosure(
  root: ExtensionManifestForSolver,
  rootSource: SourceKey | null,
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
  const initialPinned: Pinned = new Map();
  for (const [id, copy] of opts.installed) {
    initialPinned.set(id, { version: copy.version, source: copy.source, planned: false });
  }
  const ancestors = new Set<string>();
  const manifestCache: ManifestCache = new Map();
  const resolved: Map<string, ResolvedNode> = new Map();
  const initialInstalled = new Map(opts.installed);
  const collected: unknown[] | undefined = opts.collectConflicts === true ? [] : undefined;

  await visit(root, rootSource, {
    pinned: initialPinned,
    ranges: initialRanges,
    ancestors,
    fetcher,
    manifestCache,
    resolved,
    initialInstalled,
    collected,
  });

  if (collected !== undefined && collected.length === 1) throw collected[0];
  if (collected !== undefined && collected.length > 1)
    throw new DependencyConflictsError(collected);
  return { nodes: topoSort(resolved) };
}

/** A refusal a collecting solve records and moves past; anything else (a bug) still throws at once. */
function isCollectableRefusal(e: unknown): boolean {
  return (
    e instanceof DependencyConflictError ||
    e instanceof OfflineDependencyResolutionError ||
    e instanceof RegistryError ||
    e instanceof TrustBlockError
  );
}

/**
 * `resolveClosure` never checks what OTHER installed extensions require of the root itself, so an
 * update first checks that every installed dependent's range still admits `toVersion`. The root's
 * own entry in `activeConstraints` (its old edges) is ignored.
 */
export function assertRootConstraintsSatisfied(
  rootId: string,
  toVersion: string,
  activeConstraints: ReadonlyMap<string, ReadonlyMap<string, string>>,
): void {
  const constraintsOnRoot: Array<{ from: string; range: string }> = [];
  for (const [dependent, depMap] of activeConstraints) {
    if (dependent === rootId) continue;
    const range = depMap.get(rootId);
    if (range !== undefined) {
      constraintsOnRoot.push({ from: dependent, range });
    }
  }
  const unsatisfiedConstraints = constraintsOnRoot.filter(
    (c) => !semver.satisfies(toVersion, c.range),
  );
  if (unsatisfiedConstraints.length > 0) {
    throw new DependencyConflictError({
      kind: "unsatisfiable",
      id: rootId,
      constraints: unsatisfiedConstraints,
      availableVersions: [toVersion],
    });
  }
}

function describeSource(source: SourceKey | null): string {
  return source === null ? "a local folder" : registryNameOf(source);
}

function sourceMismatch(
  depId: string,
  parentId: string,
  pin: Pin,
  target: SourceKey,
): RegistryError {
  const targetName = registryNameOf(target);
  const from =
    pin.source !== null && registryNameOf(pin.source) === targetName
      ? `${targetName} under a different root key`
      : describeSource(pin.source);
  if (pin.planned) {
    return new RegistryError(
      "ERR_DEPENDENCY_SOURCE_MISMATCH",
      `${depId} is already planned from ${from} but ${parentId} needs it from ${targetName}; one install takes each extension from a single registry`,
    );
  }
  return new RegistryError(
    "ERR_DEPENDENCY_SOURCE_MISMATCH",
    `${depId} is installed from ${from} but ${parentId} needs it from ${targetName}; remove it (nimbus extension remove ${depId}) and re-run the install so it is fetched from ${targetName}`,
  );
}

async function listVersionsOrOffline(
  depId: string,
  parentId: string,
  source: SourceKey | null,
  fetcher: RegistryFetcher,
): Promise<readonly string[]> {
  try {
    return await fetcher.listVersions(depId, source);
  } catch (e) {
    if (isRegistryUnreachable(e)) {
      throw new OfflineDependencyResolutionError({ missingId: depId, parent: parentId });
    }
    throw e;
  }
}

/**
 * Picks `depId`'s version and source. A pinned id (installed, or chosen earlier in this solve) is
 * reused when it comes from `target` (or `target` is null: installed copies only) and satisfies
 * every range; otherwise the solve is refused — never a second version or a second source.
 */
async function resolveDepCandidate(
  depId: string,
  parentId: string,
  target: SourceKey | null,
  constraintList: DependencyConstraint[],
  { pinned, fetcher }: Pick<SolveContext, "pinned" | "fetcher">,
): Promise<{ version: string; source: SourceKey | null }> {
  const pin = pinned.get(depId);
  if (pin !== undefined) {
    if (target !== null && pin.source !== target) {
      throw sourceMismatch(depId, parentId, pin, target);
    }
    if (constraintList.every((c) => semver.satisfies(pin.version, c.range))) {
      return { version: pin.version, source: pin.source };
    }
    // Listed only to report what exists: a pinned id is never replaced by the plan.
    const available = await listVersionsOrOffline(depId, parentId, target, fetcher);
    throw new DependencyConflictError({
      kind: "unsatisfiable",
      id: depId,
      constraints: [...constraintList],
      availableVersions: [...available],
    });
  }
  const versions = await listVersionsOrOffline(depId, parentId, target, fetcher);
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
  return { version: candidate, source: target };
}

async function loadDepManifest(
  depId: string,
  parentId: string,
  candidate: string,
  source: SourceKey | null,
  { fetcher, manifestCache }: Pick<SolveContext, "fetcher" | "manifestCache">,
): Promise<ExtensionManifestForSolver> {
  const cacheKey = `${source}|${depId}@${candidate}`;
  const cached = manifestCache.get(cacheKey);
  if (cached) return cached;
  let depManifest: ExtensionManifestForSolver;
  try {
    depManifest = await fetcher.fetchManifest(depId, candidate, source);
  } catch (e) {
    if (isRegistryUnreachable(e)) {
      throw new OfflineDependencyResolutionError({ missingId: depId, parent: parentId });
    }
    throw e;
  }
  manifestCache.set(cacheKey, depManifest);
  return depManifest;
}

type SolveContext = {
  pinned: Pinned;
  ranges: Ranges;
  ancestors: Set<string>;
  fetcher: RegistryFetcher;
  manifestCache: ManifestCache;
  resolved: Map<string, ResolvedNode>;
  initialInstalled: ReadonlyMap<string, InstalledForSolver>;
  /** Set ⇒ a refused dependency is recorded here and its siblings are still solved. */
  collected: unknown[] | undefined;
};

function validatedRange(depId: string, fromId: string, spec: DependencySpec): string {
  const range: unknown = spec?.range;
  if (typeof range !== "string" || !semver.validRange(range)) {
    throw new DependencyConflictError({
      kind: "range_invalid",
      id: depId,
      constraints: [{ from: fromId, range: String(range) }],
    });
  }
  return range;
}

/** Solves one of `current`'s dependencies: its version, its source, then its own subtree. */
async function visitDependency(
  current: ExtensionManifestForSolver,
  currentSource: SourceKey | null,
  depId: string,
  spec: DependencySpec,
  deps: ResolvedDep[],
  ctx: SolveContext,
): Promise<void> {
  const range = validatedRange(depId, current.id, spec);

  if (ctx.ancestors.has(depId)) {
    const chain = [...ctx.ancestors, depId];
    throw new DependencyConflictError({ kind: "cycle", id: depId, chain });
  }

  const constraintList = ctx.ranges.get(depId) ?? [];
  constraintList.push({ from: current.id, range });
  ctx.ranges.set(depId, constraintList);

  // The FULL spec, so an object dependency's `registry` reaches the fetcher.
  const target = ctx.fetcher.targetSource(currentSource, depId, spec);

  // The three awaits below are SERIAL by design: this is a depth-first solve over shared,
  // mutable `ctx` state, so no dependency can be resolved concurrently with another.
  const chosen = await resolveDepCandidate(depId, current.id, target, constraintList, ctx); // NOSONAR S9382: the candidate is chosen against the ranges and pins earlier siblings' subtrees left in ctx
  const { version, source } = chosen;
  const depManifest = await loadDepManifest(depId, current.id, version, source, ctx); // NOSONAR S9382: needs this iteration's candidate, and shares ctx.manifestCache with the rest of the solve

  deps.push({
    id: depId,
    range,
    resolvedVersion: chosen.version,
    registry: target === null ? null : registryNameOf(target),
  });

  if (!ctx.resolved.has(depId)) {
    await visit(depManifest, chosen.source, ctx); // NOSONAR S9382: depth-first recursion - cycle detection relies on ctx.ancestors holding exactly the current path, one subtree at a time
  }
}

async function visit(
  current: ExtensionManifestForSolver,
  currentSource: SourceKey | null,
  ctx: SolveContext,
): Promise<void> {
  ctx.ancestors.add(current.id);
  const prior = ctx.pinned.get(current.id);
  // A reused installed copy stays "installed"; anything else is a node this solve chose.
  const planned = prior === undefined || prior.planned || prior.version !== current.version;
  ctx.pinned.set(current.id, { version: current.version, source: currentSource, planned });

  try {
    const deps: ResolvedDep[] = [];
    const depEntries = Object.entries(current.dependsOn ?? {});

    for (const [depId, spec] of depEntries) {
      try {
        await visitDependency(current, currentSource, depId, spec, deps, ctx); // NOSONAR S9382: SERIAL by design, see visitDependency
      } catch (e) {
        // A collecting solve records the refusal and solves the next sibling; this subtree is skipped.
        if (ctx.collected === undefined || !isCollectableRefusal(e)) throw e;
        ctx.collected.push(e);
      }
    }

    ctx.resolved.set(current.id, {
      id: current.id,
      version: current.version,
      newlyInstalled: ctx.initialInstalled.get(current.id)?.version !== current.version,
      deps,
      source: currentSource,
    });
  } finally {
    ctx.ancestors.delete(current.id);
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
