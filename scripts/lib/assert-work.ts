// scripts/lib/assert-work.ts

/**
 * A gate that ran but processed nothing is a FAILURE, not a pass.
 *
 * Three separate incidents in PR #1038 trace to a tool that ran, did nothing, and said so quietly —
 * most damagingly biome reporting "0 files processed" from inside a worktree, which made the whole
 * preflight aggregate look broken and got it skipped.
 *
 * Deliberately narrow: applied to the two gates that can actually report zero work. A per-gate
 * regex on every manifest entry was considered and rejected — a regex over tool output is itself a
 * silent-failure surface when a tool changes its wording on upgrade.
 *
 * That fragility applies to the two gates this IS wired to as well; neither tool is exact-pinned, so
 * a reworded upgrade would break the match. Accepted deliberately: an unrecognised output fails
 * loudly here rather than passing quietly, which is the direction this whole check exists to enforce.
 *
 * Report zero *after* every pattern has been tried, never on the first zero seen: with more than one
 * pattern, an early zero-match would otherwise mask a later pattern carrying the real positive count
 * and fail a run that did work.
 */
export function assertDidWork(output: string, patterns: readonly RegExp[], label: string): void {
  let zeroCount: number | undefined;
  for (const re of patterns) {
    const m = re.exec(output);
    if (m === null) continue;
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isNaN(n)) continue;
    if (n > 0) return;
    zeroCount ??= n;
  }
  if (zeroCount !== undefined) {
    throw new Error(
      `${label}: did no work (${String(zeroCount)} units processed) — this is a failure, not a pass`,
    );
  }
  throw new Error(`${label}: could not confirm any work was done (no unit count found in output)`);
}
