/**
 * Median of a numeric array, over a sorted COPY — never mutates the input.
 * `null` for an empty input: pre-mortem's honesty rule is that an unmeasurable
 * figure is reported as absent, never as a fabricated `0`.
 *
 * Extracted because `agents/premortem.ts` and `premortem/risks.ts` held
 * byte-identical copies. This module is pure — no database, no config — so
 * importing it does not compromise `risks.ts`'s deliberate database-free shape.
 *
 * The two index reads are asserted rather than `?? 0`-defaulted, which is what
 * both copies did. `noUncheckedIndexedAccess` widens them to `| undefined`, but
 * after the emptiness check `mid` is always in range (and `mid - 1` only when
 * the length is even, so `mid >= 1`). A `?? 0` for a case that cannot happen is
 * dead code that would quietly fabricate a `0` — the one thing every figure in
 * this subsystem is forbidden to do — and it is unreachable, so no test can
 * ever cover it. Asserting states the reasoning instead of hiding it.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] as number;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + upper) / 2 : upper;
}
