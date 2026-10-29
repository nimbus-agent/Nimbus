import type { Database } from "bun:sqlite";
import { isInstalledAsDependency } from "../automation/extension-store.ts";
import { forwardDeps, reverseDeps } from "./dependency-store.ts";

function sortedForwardIds(db: Database, id: string): string[] {
  return forwardDeps(db, id)
    .map((d) => d.id)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Grows `set` to its fixed point: a candidate (one of `seeds`, or a dependency of a member) joins
 * when it was installed only as a dependency (marker 1) and every extension that still depends on it
 * is already in the set. `kept` never joins. A dangling edge names no row, so its marker reads 0 and
 * it is skipped.
 */
function growOrphanSet(
  db: Database,
  set: Set<string>,
  seeds: readonly string[],
  kept: ReadonlySet<string>,
): void {
  let grew = true;
  while (grew) {
    grew = false;
    const candidates = [...seeds, ...[...set].flatMap((member) => sortedForwardIds(db, member))];
    for (const candidate of candidates) {
      if (set.has(candidate) || kept.has(candidate)) continue;
      if (!isInstalledAsDependency(db, candidate)) continue;
      if (!reverseDeps(db, candidate).every((r) => set.has(r.extensionId))) continue;
      set.add(candidate);
      grew = true;
    }
  }
}

/**
 * Reverse post-order of a DFS from each start (in order) over edges inside `set`: a topological
 * order in which every package comes before the packages it depends on.
 */
function dependentsFirst(
  db: Database,
  set: ReadonlySet<string>,
  starts: readonly string[],
): string[] {
  const visited = new Set<string>();
  const postOrder: string[] = [];
  const visit = (id: string): void => {
    visited.add(id);
    for (const dep of sortedForwardIds(db, id)) {
      if (set.has(dep) && !visited.has(dep)) visit(dep);
    }
    postOrder.push(id);
  };
  for (const start of starts) {
    if (set.has(start) && !visited.has(start)) visit(start);
  }
  return postOrder.reverse();
}

/**
 * The packages that removing `removedId` leaves needed by nothing: each was installed only as a
 * dependency (`installed_as_dependency = 1`) and every extension that still depends on it is itself
 * being removed. Computed over the dependency edges as they stand, with `removedId`'s own edges
 * still present, so call it BEFORE `clearDeps(db, removedId)`.
 *
 * Fixed point: start from `{removedId}` and keep adding any dependency reachable from the set whose
 * marker is 1 and whose reverse dependents all lie inside the set. An explicitly installed package
 * (marker 0) is never added, nor is one an extension outside the set still needs; a dependency edge
 * left dangling by an earlier `--force` removal names no row, so its marker reads 0 and it is skipped.
 * Two dependency-installed packages that depend on each other are kept: neither's dependents are
 * ever all inside the set, and no removal order could avoid `reverse_dep_blocked` for them.
 *
 * Ordered so every package comes before the packages it depends on: removing them in order never
 * trips `reverse_dep_blocked`.
 */
export function orphanedDependencies(db: Database, removedId: string): string[] {
  const removing = new Set<string>([removedId]);
  growOrphanSet(db, removing, [], new Set());
  // Every member is reachable from `removedId` by construction.
  return dependentsFirst(db, removing, [removedId]).filter((id) => id !== removedId);
}

/**
 * The packages a change to `dependentId`'s edges (a downgrade, or crash recovery promoting an older
 * version) left needed by nothing. `droppedDepIds` are its old dependencies the new edges no longer
 * name. Call it AFTER the edges are rewritten.
 *
 * Same fixed point as `orphanedDependencies`, seeded from the dropped ids instead of a removed
 * package: a dropped package joins when it is marker 1 and nothing outside the set depends on it,
 * and its own marker-1 dependencies follow on the same rule. `dependentId` itself, which stays
 * installed, never joins; an explicitly installed package (marker 0) or one something else still
 * needs never does either. Ordered dependents first, so removing them in order never trips
 * `reverse_dep_blocked`.
 */
export function orphanedAfterEdgeChange(
  db: Database,
  dependentId: string,
  droppedDepIds: readonly string[],
): string[] {
  const seeds = [...new Set(droppedDepIds)].sort((a, b) => a.localeCompare(b));
  const orphaned = new Set<string>();
  growOrphanSet(db, orphaned, seeds, new Set([dependentId]));
  return dependentsFirst(db, orphaned, seeds);
}
