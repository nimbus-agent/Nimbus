export type FileNamespacesArgs = { file: string; json: boolean; namespaces: string[] };

/**
 * Parse the shared positional-file + --json + repeatable --namespace flags
 * used by the conflicts and ghost CLI commands.
 *
 * @param args     Raw argv slice (after the subcommand token).
 * @param cmdName  Command name used in the usage error message (e.g. "conflicts").
 */
export function parseFileNamespacesArgs(args: string[], cmdName: string): FileNamespacesArgs {
  const positional: string[] = [];
  let json = false;
  const namespaces: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) {
        throw new Error("--namespace requires a value");
      }
      namespaces.push(v.trim());
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    }
  }
  const file = positional.join(" ").trim();
  if (file.length === 0) {
    throw new Error(`Usage: nimbus ${cmdName} "<file>" [--json] [--namespace <n>]`);
  }
  return { file, json, namespaces };
}
