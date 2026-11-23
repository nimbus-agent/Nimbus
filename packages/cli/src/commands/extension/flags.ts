export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function takeFlagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

export function stripFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      a === "--yes" ||
      a === "-y" ||
      a === "--json" ||
      a === "--model" ||
      a === "--remote" ||
      a === "--clean-deps" ||
      a?.startsWith("--network=") === true
    ) {
      continue;
    }
    if (
      a === "--filter" ||
      a === "--publisher-key" ||
      a === "--registry" ||
      a === "--version" ||
      a === "--channel" ||
      a === "--to" ||
      a === "--accept-publisher-key" ||
      a === "--index" ||
      a === "--network" ||
      a === "--into" ||
      a === "--publisher"
    ) {
      i += 1;
      continue;
    }
    out.push(a as string);
  }
  return out;
}
