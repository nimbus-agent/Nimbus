/**
 * Readers of a parsed manifest's `dependsOn` that compare versions only. The dependency solver
 * reads each entry whole (`dependency-graph.ts`), because an object entry's `registry` decides
 * where it is resolved.
 */
import type { DependencySpec } from "@nimbus-dev/registry-format";

/** Every entry's range, whatever registry it names — for constraint checks, which compare versions only. */
export function rangesOf(
  dependsOn: Readonly<Record<string, DependencySpec>> | undefined,
): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [depId, spec] of Object.entries(dependsOn ?? {})) out[depId] = spec.range;
  return out;
}
