import { codeUnitCompare } from "./lanes/caps.ts";

/**
 * Cascade ranking (Phase 10 IC4, spec § 5.4): among open incident records that opened within 30 minutes of one
 * another, name ONE root and rank the rest as downstream, each with the reason. A PURE function of the open
 * records and the declared `depends_on` map; nothing is stored (the cascade depends on sibling records and on
 * time, so it would change a record's hash whenever a sibling appears) and nothing is random.
 *
 * Wording is D-IC-2: a root is a "root candidate" ranked by declared dependency, shared deployment and open
 * time; nothing here says "cause". A reason that names a path exists only when the path search returned one,
 * so a path-less `declared_dependency` cannot be built (the type carries the path).
 *
 * The rank key, ascending (design D of the IC4 plan):
 *   (i)   0 for a TOP candidate: at least one other record in the cluster depends on its service (transitively)
 *         AND no record in the cluster is one it depends on. X upstream of Y strictly outranks Y whatever the
 *         times; a finite antisymmetric transitive relation has a maximal element, so a cluster that holds any
 *         relation always has a top candidate and the root is never downstream of a member.
 *   (ii)  0 when the record cites a deployment another record of the cluster also cites;
 *   (iii) the earlier open time; (iv) the id by code unit.
 */

export const CASCADE_WINDOW_MS = 30 * 60_000;
export const CASCADE_CLUSTER_CAP = 30;
/** The reachability search stops after this many services (graph size, not depth). */
export const REACH_VISIT_CAP = 64;

export type CascadeRecord = {
  readonly id: string;
  readonly service: string | null;
  readonly source: string;
  readonly openedAtMs: number;
  /** The deployment item id the record's change lane cites, or null. */
  readonly deploymentId: string | null;
};

export type DependsOn = ReadonlyMap<string, readonly string[]>;

export type CascadeReason =
  /** A downstream member: the path from its service to the root's, exactly as the search returned it. */
  | {
      readonly kind: "declared_dependency";
      readonly path: readonly string[];
      readonly dependents?: never;
    }
  /** The root: how many other records of the cluster run on a service that depends on the root's. */
  | { readonly kind: "declared_dependency"; readonly dependents: number; readonly path?: never }
  | { readonly kind: "shared_deployment"; readonly deploymentId: string }
  /** `minutesAfterRoot` is negative for a member that opened BEFORE the root. */
  | { readonly kind: "time_only"; readonly minutesAfterRoot: number };

export type CascadeMember = {
  readonly recordId: string;
  readonly role: "root" | "downstream";
  readonly reason: CascadeReason;
};

export type CascadeGroup = {
  readonly root: string;
  /** The root first, then the downstream records by open time then id. */
  readonly members: readonly CascadeMember[];
  /** True when any reachability search hit {@link REACH_VISIT_CAP} (the relation is then treated as absent). */
  readonly reachCapped: boolean;
  readonly relation: "declared" | "none";
  readonly relationLabel: string;
};

const LABEL_DECLARED = "ranked by declared depends_on, then shared deployment, then open time";
const LABEL_NONE =
  "no depends_on is declared among these services; ranked by shared deployment, then open time";

type Reach = { readonly path: readonly string[] | null; readonly capped: boolean };

/** Breadth-first search along `depends_on` edges (a cycle terminates: a visited set). Unconfigured targets are ignored. */
function reachOnce(dep: DependsOn, from: string, to: string): Reach {
  if (from === to) return { path: [from], capped: false };
  const parent = new Map<string, string | null>([[from, null]]);
  let frontier: string[] = [from];
  while (frontier.length > 0) {
    const level = expandLevel(dep, frontier, parent, to);
    if (!Array.isArray(level)) return level;
    frontier = level;
  }
  return { path: null, capped: false };
}

/** One BFS level: the next frontier, or the search's result once the target or the visit cap is reached. */
function expandLevel(
  dep: DependsOn,
  frontier: readonly string[],
  parent: Map<string, string | null>,
  to: string,
): string[] | Reach {
  const next: string[] = [];
  for (const at of frontier) {
    for (const target of dep.get(at) ?? []) {
      if (!dep.has(target) || parent.has(target)) continue;
      if (parent.size >= REACH_VISIT_CAP) return { path: null, capped: true };
      parent.set(target, at);
      if (target === to) return { path: pathTo(parent, target), capped: false };
      next.push(target);
    }
  }
  return next;
}

/** The path from the search's start to `target`, read back through the parent links. */
function pathTo(parent: ReadonlyMap<string, string | null>, target: string): string[] {
  const path: string[] = [];
  for (let cur: string | null = target; cur !== null; cur = parent.get(cur) ?? null) {
    path.unshift(cur);
  }
  return path;
}

/** Memoised reachability over one cluster's services; remembers whether any search was capped. */
class Relations {
  capped = false;
  private readonly memo = new Map<string, Reach>();
  constructor(private readonly dep: DependsOn) {}

  reach(from: string, to: string): Reach {
    const key = `${from}\u0000${to}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const r = reachOnce(this.dep, from, to);
    if (r.capped) this.capped = true;
    this.memo.set(key, r);
    return r;
  }

  /** X is upstream of Y: Y depends on X (transitively) and X does not depend on Y. Antisymmetric. */
  upstream(x: string | null, y: string | null): boolean {
    if (x === null || y === null || x === y) return false;
    const down = this.reach(y, x);
    const up = this.reach(x, y);
    // A search that hit the cap proves nothing either way: the relation is treated as absent.
    if (down.capped || up.capped) return false;
    return down.path !== null && up.path === null;
  }
}

const byOpen = (a: CascadeRecord, b: CascadeRecord): number =>
  a.openedAtMs !== b.openedAtMs ? a.openedAtMs - b.openedAtMs : codeUnitCompare(a.id, b.id);

/** Anchor-window clusters: the earliest unassigned record opens one holding the records within 30 minutes AFTER it. */
export function clusterRecords(records: readonly CascadeRecord[]): CascadeRecord[][] {
  const sorted = [...records].sort(byOpen);
  const taken = new Set<string>();
  const clusters: CascadeRecord[][] = [];
  for (const anchor of sorted) {
    if (taken.has(anchor.id)) continue;
    const cluster: CascadeRecord[] = [];
    for (const r of sorted) {
      if (taken.has(r.id)) continue;
      if (r.openedAtMs - anchor.openedAtMs > CASCADE_WINDOW_MS) break;
      cluster.push(r);
      taken.add(r.id);
      if (cluster.length >= CASCADE_CLUSTER_CAP) break;
    }
    clusters.push(cluster);
  }
  return clusters;
}

type Ranked = {
  readonly record: CascadeRecord;
  readonly top: 0 | 1;
  readonly shared: 0 | 1;
};

function rankCluster(cluster: readonly CascadeRecord[], rel: Relations): Ranked[] {
  const cited = new Map<string, number>();
  for (const r of cluster) {
    if (r.deploymentId !== null) cited.set(r.deploymentId, (cited.get(r.deploymentId) ?? 0) + 1);
  }
  return cluster
    .map((r): Ranked => {
      const dependents = cluster.some((q) => q.id !== r.id && rel.upstream(r.service, q.service));
      const hasUpstream = cluster.some((q) => q.id !== r.id && rel.upstream(q.service, r.service));
      const shared = r.deploymentId !== null && (cited.get(r.deploymentId) ?? 0) > 1;
      return { record: r, top: dependents && !hasUpstream ? 0 : 1, shared: shared ? 0 : 1 };
    })
    .sort((a, b) => a.top - b.top || a.shared - b.shared || byOpen(a.record, b.record));
}

function downstreamReason(m: CascadeRecord, root: CascadeRecord, rel: Relations): CascadeReason {
  if (m.service !== null && root.service !== null && rel.upstream(root.service, m.service)) {
    const path = rel.reach(m.service, root.service).path;
    // The path is the search's own result: `upstream` held, so it exists. Fall through if it somehow does not.
    if (path !== null) return { kind: "declared_dependency", path };
  }
  if (m.deploymentId !== null && m.deploymentId === root.deploymentId) {
    return { kind: "shared_deployment", deploymentId: m.deploymentId };
  }
  // The sign is kept: the root can rank ahead of a member that opened EARLIER (a shared deployment, a dependent).
  return {
    kind: "time_only",
    minutesAfterRoot: Math.round((m.openedAtMs - root.openedAtMs) / 60_000),
  };
}

function rootReason(
  root: CascadeRecord,
  cluster: readonly CascadeRecord[],
  rel: Relations,
  sharedRank: 0 | 1,
): CascadeReason {
  const dependents = cluster.filter(
    (q) => q.id !== root.id && rel.upstream(root.service, q.service),
  ).length;
  if (dependents > 0) return { kind: "declared_dependency", dependents };
  if (sharedRank === 0 && root.deploymentId !== null) {
    return { kind: "shared_deployment", deploymentId: root.deploymentId };
  }
  return { kind: "time_only", minutesAfterRoot: 0 };
}

function groupOfCluster(cluster: readonly CascadeRecord[], dep: DependsOn): CascadeGroup {
  const rel = new Relations(dep);
  const ranked = rankCluster(cluster, rel);
  const first = ranked[0] as Ranked;
  const root = first.record;
  const relation: CascadeGroup["relation"] = ranked.some((x) => x.top === 0) ? "declared" : "none";
  const members: CascadeMember[] = [
    { recordId: root.id, role: "root", reason: rootReason(root, cluster, rel, first.shared) },
    ...[...cluster]
      .filter((m) => m.id !== root.id)
      .sort(byOpen)
      .map(
        (m): CascadeMember => ({
          recordId: m.id,
          role: "downstream",
          reason: downstreamReason(m, root, rel),
        }),
      ),
  ];
  return {
    root: root.id,
    members,
    reachCapped: rel.capped,
    relation,
    relationLabel: relation === "declared" ? LABEL_DECLARED : LABEL_NONE,
  };
}

/** Every cluster of two or more open records, each as one group (a cluster of one is not a cascade). */
export function rankCascades(
  records: readonly CascadeRecord[],
  dependsOn: DependsOn,
): CascadeGroup[] {
  return clusterRecords(records)
    .filter((c) => c.length >= 2)
    .map((c) => groupOfCluster(c, dependsOn));
}

/** The group a record belongs to, or null when it is in no cluster of two or more. */
export function groupOf(groups: readonly CascadeGroup[], recordId: string): CascadeGroup | null {
  return groups.find((g) => g.members.some((m) => m.recordId === recordId)) ?? null;
}
