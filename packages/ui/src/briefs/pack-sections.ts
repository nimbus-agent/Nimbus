import type { CatalogAgent, CatalogListResult, PackListResult } from "../ipc/types";

/**
 * Agents the desktop does not surface (spec § 5.1): they have side effects. `preflight` raises an
 * owner HITL prompt (I24) and `premortem` writes watcher rows, so they stay CLI-only.
 */
export const DESKTOP_EXCLUDED_AGENTS: ReadonlySet<string> = new Set(["preflight", "premortem"]);

export type PackSection = {
  readonly id: string;
  readonly name: string;
  readonly agents: readonly CatalogAgent[];
};

/**
 * One section per active pack, in `installed` order, listing the pack's `visibleAgents` in the
 * gateway's order. Nothing is computed from a failed or partial answer: a `listError`, a skipped
 * pack, an agent the catalog lacks or hides, or a section left empty all yield no entry.
 */
export function packSections(
  packs: PackListResult | null,
  catalog: CatalogListResult | null,
): readonly PackSection[] {
  if (packs === null || catalog === null || packs.listError !== undefined) return [];
  const byName = new Map(catalog.agents.map((a) => [a.name, a] as const));
  const skipped = new Set(packs.skipped.map((s) => s.packId));
  const out: PackSection[] = [];
  for (const p of packs.installed) {
    if (skipped.has(p.id)) continue;
    const agents: CatalogAgent[] = [];
    for (const name of p.visibleAgents ?? []) {
      const a = byName.get(name);
      if (a === undefined || !a.visible || DESKTOP_EXCLUDED_AGENTS.has(name)) continue;
      agents.push(a);
    }
    if (agents.length > 0) out.push({ id: p.id, name: p.name, agents });
  }
  return out;
}
