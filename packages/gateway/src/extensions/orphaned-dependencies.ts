import type { Database } from "bun:sqlite";
import { isInstalledAsDependency } from "../automation/extension-store.ts";
import { forwardDeps, reverseDeps } from "./dependency-store.ts";

function sortedForwardIds(db: Database, id: string): string[] {
  return forwardDeps(db, id)
    .map((d) => d.id)
    .sort((a, b) => a.localeCompare(b));
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
  let grew = true;
  while (grew) {
    grew = false;
    for (const member of [...removing]) {
      for (const dep of sortedForwardIds(db, member)) {
        if (removing.has(dep)) continue;
        if (!isInstalledAsDependency(db, dep)) continue;
        if (!reverseDeps(db, dep).every((r) => removing.has(r.extensionId))) continue;
        removing.add(dep);
        grew = true;
      }
    }
  }

  // Reverse post-order of a DFS from the removed id over edges inside the set: a topological order
  // in which dependents come first. Every member is reachable from `removedId` by construction.
  const visited = new Set<string>();
  const postOrder: string[] = [];
  const visit = (id: string): void => {
    visited.add(id);
    for (const dep of sortedForwardIds(db, id)) {
      if (removing.has(dep) && !visited.has(dep)) visit(dep);
    }
    postOrder.push(id);
  };
  visit(removedId);
  return postOrder.reverse().filter((id) => id !== removedId);
}
