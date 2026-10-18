/** `nimbus registry …` dispatcher. `maintain` is offline; the client subcommands land later. */
import { runRegistryMaintain } from "./registry-maintain.ts";

const USAGE = "Usage: nimbus registry maintain init|add|remove ...\n";

export async function runRegistry(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "maintain") {
    const code = await runRegistryMaintain(rest);
    if (code !== 0) process.exit(code);
    return;
  }
  process.stderr.write(USAGE);
  process.exit(2);
}
