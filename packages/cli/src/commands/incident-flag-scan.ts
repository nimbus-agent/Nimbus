/**
 * The flag scanner the `nimbus incident postmortem` (IC7a) and `nimbus incident update` (IC9b) subcommands share:
 * at most one positional id, each value flag once with a value that is not another flag, each boolean flag once,
 * and anything else (an unknown `--flag`, a second positional) a usage error (`undefined`).
 */
export type ScannedFlags = {
  readonly values: Map<string, string>;
  readonly bools: Set<string>;
  readonly id: string | undefined;
};

export function scanFlags(
  argv: readonly string[],
  valueFlags: ReadonlySet<string>,
  boolFlags: ReadonlySet<string>,
): ScannedFlags | undefined {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  let id: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (boolFlags.has(a)) {
      if (bools.has(a)) return undefined;
      bools.add(a);
    } else if (valueFlags.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v === "" || v.startsWith("--") || values.has(a)) return undefined;
      values.set(a, v);
      i += 1;
    } else if (a.startsWith("--") || id !== undefined) {
      return undefined;
    } else {
      id = a;
    }
  }
  return { values, bools, id };
}
