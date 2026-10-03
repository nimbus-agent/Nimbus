/**
 * Argv helpers shared by the bench entry points (`bench-runner.ts`, `bench-cli.ts`, `bench-ci.ts`).
 *
 * Kept free of imports on purpose: `bench-ci.ts` runs as its own CI step and must not load the
 * bench surface registry just to read a flag.
 */

/**
 * The value that follows the first `flag` in `args`, or `undefined` when the flag is absent or is
 * the last argument.
 */
export function takeFlag(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

/** Whether `flag` appears anywhere in `args`. */
export function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}
