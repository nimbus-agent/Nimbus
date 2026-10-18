/** `nimbus registry …` dispatcher. `maintain` is offline; the client subcommands land later. */
import { runRegistryMaintain } from "./registry-maintain.ts";

const USAGE = "Usage: nimbus registry maintain init|add|remove ...\n";

/**
 * The seams `runRegistry` reaches through, so a test can drive the router without a real
 * `process.exit`. The defaults are the real thing; production callers pass nothing.
 */
export interface RegistryCmdDeps {
  readonly maintain: (args: string[]) => Promise<number>;
  readonly writeErr: (s: string) => void;
  readonly exit: (code: number) => never;
}

const DEFAULT_DEPS: RegistryCmdDeps = {
  maintain: (args) => runRegistryMaintain(args),
  writeErr: (s) => void process.stderr.write(s),
  exit: (code) => process.exit(code),
};

export async function runRegistry(
  args: string[],
  deps: RegistryCmdDeps = DEFAULT_DEPS,
): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "maintain") {
    const code = await deps.maintain(rest);
    if (code !== 0) deps.exit(code);
    return;
  }
  deps.writeErr(USAGE);
  deps.exit(2);
}
