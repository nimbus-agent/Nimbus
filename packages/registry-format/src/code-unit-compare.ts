/**
 * Deterministic, locale-independent code-unit comparison: the order of a bare `.sort()` on strings,
 * spelled out. Never `localeCompare`, which is locale-dependent and would make anything signed or
 * printed in this order differ between machines. A pure copy of the gateway's
 * `util/code-unit-compare.ts`, which this workspace may not import.
 */
export function codeUnitCompare(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}
