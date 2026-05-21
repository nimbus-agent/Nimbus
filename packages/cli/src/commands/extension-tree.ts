/**
 * Pure ASCII dependency-tree renderer for `nimbus extension list --tree`.
 *
 * Intentionally has no IPC imports — this module is pure logic so it can be
 * unit-tested without a running Gateway. Types mirror the forwardDeps shape
 * returned by `extension.info` (Task 14) but are defined locally here so the
 * CLI package stays within its IPC-only boundary (no gateway src imports).
 */

export interface ForwardDep {
  readonly id: string;
  readonly range: string;
}

export interface InstalledExtensionForTree {
  readonly id: string;
  readonly version: string;
  readonly forwardDeps: readonly ForwardDep[];
}

/**
 * Pure ASCII renderer for `nimbus extension list --tree`. NO_COLOR-aware (no
 * colour escapes are emitted — pure ASCII box-drawing). Cycle-safe via a
 * visited-set; nodes already shown on the current branch get an
 * "(already shown)" suffix so the tree terminates without truncating
 * information.
 *
 * Roots are determined as the set of installed extensions that no other
 * installed extension declares as a forward dependency. Sub-trees walk forward
 * edges. Alphabetical ordering is applied at every level so output is
 * deterministic across runs.
 *
 * Returns an empty string for an empty install set.
 */
export function renderTree(installed: readonly InstalledExtensionForTree[]): string {
  if (installed.length === 0) return "";

  const byId = new Map(installed.map((e) => [e.id, e]));

  // Build the set of ids that appear as a forward dependency of any extension.
  const dependents = new Set<string>();
  for (const e of installed) {
    for (const f of e.forwardDeps) {
      dependents.add(f.id);
    }
  }

  // Roots: installed extensions that no other installed extension depends on.
  const roots = installed
    .filter((e) => !dependents.has(e.id))
    .map((e) => e.id)
    .sort();

  const out: string[] = [];
  // One shared seen-set across all roots so that a node expanded under one
  // root is marked "(already shown)" if it appears under a later root too.
  const seen = new Set<string>();
  for (let i = 0; i < roots.length; i++) {
    const rootId = roots[i];
    if (rootId !== undefined) {
      walk(rootId, "", i === roots.length - 1, seen, out, byId);
    }
  }
  return out.join("\n");
}

function walk(
  id: string,
  prefix: string,
  isLast: boolean,
  seen: Set<string>,
  out: string[],
  byId: Map<string, InstalledExtensionForTree>,
): void {
  const node = byId.get(id);
  if (node === undefined) return;

  // Box-drawing connectors: no marker for root nodes (prefix === ""); ├─ for
  // non-last children; └─ for the last child.
  const marker = prefix === "" ? "" : isLast ? "└─ " : "├─ ";
  const suffix = seen.has(id) ? "  (already shown)" : "";
  out.push(`${prefix}${marker}${id}@${node.version}${suffix}`);

  // Stop expanding if already visited — the suffix above marks the reference.
  if (seen.has(id)) return;
  seen.add(id);

  // Child prefix: the continuation connector appended to the current prefix.
  // At root level (prefix === "") the indent is driven solely by isLast.
  // At deeper levels: non-last siblings show "│  "; last siblings show "   ".
  const childPrefix = prefix === "" ? (isLast ? "   " : "│  ") : prefix + (isLast ? "   " : "│  ");

  const deps = [...node.forwardDeps].sort((a, b) => a.id.localeCompare(b.id));
  deps.forEach((d, i) => {
    // Pass the shared seen set — mutations are visible to all siblings so
    // a node visited by an earlier sibling shows "(already shown)" for later ones.
    walk(d.id, childPrefix, i === deps.length - 1, seen, out, byId);
  });
}
