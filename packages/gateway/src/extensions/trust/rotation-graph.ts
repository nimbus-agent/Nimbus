/**
 * Pure graph walks over a publisher's `key.rotate` edges (marketplace trust layer, spec R3–R5, R8).
 * Fingerprints are the nodes; an edge `from → to` is one stored rotation. Cycles are allowed in the
 * data (a hostile publisher can sign them) and every walk terminates on them.
 */
export type RotationEdge = { readonly from: string; readonly to: string };

function walk(
  start: string,
  next: (node: string) => readonly string[],
  allow: (node: string) => boolean,
): Set<string> {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    for (const n of next(node)) {
      if (seen.has(n) || n === start || !allow(n)) continue;
      seen.add(n);
      queue.push(n);
    }
  }
  return seen;
}

function adjacency(edges: readonly RotationEdge[], reverse: boolean): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of edges) {
    const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
    const list = out.get(a) ?? [];
    list.push(b);
    out.set(a, list);
  }
  return out;
}

/** Every key from which `fp` can be reached by rotations (its ancestors), `fp` excluded. */
export function ancestorsOf(edges: readonly RotationEdge[], fp: string): Set<string> {
  const back = adjacency(edges, true);
  return walk(
    fp,
    (n) => back.get(n) ?? [],
    () => true,
  );
}

/**
 * The keys reachable from `fp` by rotations whose BOTH ends `usable` admits (R3: a revoked key's
 * rotations are not followed), and the TERMINAL ones among them — reachable keys with no usable
 * onward rotation. More than one terminal key is a fork (R8). With no usable rotation out of `fp`,
 * both sets are empty.
 */
export function successorsOf(
  edges: readonly RotationEdge[],
  fp: string,
  usable: (fingerprint: string) => boolean,
): { reachable: Set<string>; terminal: Set<string> } {
  if (!usable(fp)) return { reachable: new Set(), terminal: new Set() };
  const fwd = adjacency(edges, false);
  const reachable = walk(fp, (n) => fwd.get(n) ?? [], usable);
  const terminal = new Set<string>();
  for (const n of reachable) {
    const onward = (fwd.get(n) ?? []).filter((m) => usable(m) && m !== n);
    if (onward.every((m) => m === fp)) terminal.add(n);
  }
  return { reachable, terminal };
}
