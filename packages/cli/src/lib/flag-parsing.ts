/**
 * Returns true and splices the flag out of `args` if it is present.
 * Mutates `args` in-place.
 */
export function hasFlag(args: string[], flag: string): boolean {
  const i = args.indexOf(flag);
  if (i < 0) {
    return false;
  }
  args.splice(i, 1);
  return true;
}

/**
 * Returns the value immediately following `flag` in `args`, or undefined
 * if the flag is absent or has no subsequent value. Splices both the flag
 * and its value out of `args` (mutates in-place).
 */
export function shiftFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || args[i + 1] === undefined) {
    return undefined;
  }
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
