export interface ForwardDep {
  readonly id: string;
  readonly range: string;
}

export interface InstalledExtensionForTree {
  readonly id: string;
  readonly version: string;
  readonly forwardDeps: readonly ForwardDep[];
}

export function renderTree(installed: readonly InstalledExtensionForTree[]): string {
  if (installed.length === 0) return "";

  const byId = new Map(installed.map((e) => [e.id, e]));

  const dependents = new Set<string>();
  for (const e of installed) {
    for (const f of e.forwardDeps) {
      dependents.add(f.id);
    }
  }

  const roots = installed
    .filter((e) => !dependents.has(e.id))
    .map((e) => e.id)
    .sort((a, b) => a.localeCompare(b));

  const out: string[] = [];
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

  let marker: string;
  if (prefix === "") {
    marker = "";
  } else {
    marker = isLast ? "└─ " : "├─ ";
  }
  const suffix = seen.has(id) ? "  (already shown)" : "";
  out.push(`${prefix}${marker}${id}@${node.version}${suffix}`);

  if (seen.has(id)) return;
  seen.add(id);

  const indent = isLast ? "   " : "│  ";
  const childPrefix = prefix === "" ? indent : prefix + indent;

  const deps = [...node.forwardDeps].sort((a, b) => a.id.localeCompare(b.id));
  deps.forEach((d, i) => {
    walk(d.id, childPrefix, i === deps.length - 1, seen, out, byId);
  });
}
