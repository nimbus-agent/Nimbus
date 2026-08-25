import { readFile } from "node:fs/promises";

const STOP_WORDS = new Set(["--version", "--help", "-v", "-h"]);

/**
 * Matches an invocation of the `nimbus` binary followed by its subcommand.
 *
 * Two deliberate narrowings over the obvious `/(?<!\w)nimbus\s+(\w+)/`, both of
 * which produced false positives against the real landing page:
 *
 * - The lookbehind rejects a PATH whose last segment is `nimbus`, not just a
 *   longer word. `/tmp/nimbus`, `./nimbus` and `nimbus-agent/tap/nimbus` are
 *   filenames, not the command — a `\w`-only lookbehind lets every one of them
 *   through, because `/`, `.` and `-` are not word characters.
 * - The separator is `[ \t]`, not `\s`, so a match cannot span a NEWLINE. With
 *   `\s` the two-line install snippet
 *   `tar -xzf … -C /tmp/nimbus` / `less /tmp/nimbus/install.sh`
 *   was read as the command `nimbus less`.
 */
const NIMBUS_INVOCATION = /(?<![\w/\\.-])nimbus[ \t]+([a-z][a-z0-9-]*)/g;

export function extractReadmeCliCommands(markdown: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(NIMBUS_INVOCATION.source, "g");
  for (const m of markdown.matchAll(pattern)) {
    const cmd = m[1];
    if (cmd && !STOP_WORDS.has(cmd)) found.add(cmd);
  }
  return [...found];
}

export interface ValidateResult {
  ok: boolean;
  missing: string[];
}

export function validateReadmeCommands(
  readmeCommands: string[],
  registeredCommands: string[],
): ValidateResult {
  const registered = new Set(registeredCommands);
  const missing = readmeCommands.filter((c) => !registered.has(c));
  return { ok: missing.length === 0, missing };
}

export async function readRegisteredCommands(): Promise<string[]> {
  try {
    const mod = await import("../../packages/cli/src/commands/registry.ts");
    const names = (mod as { COMMAND_NAMES?: readonly string[] }).COMMAND_NAMES;
    if (Array.isArray(names)) return [...names];
  } catch {
    // Registry module not present or doesn't export COMMAND_NAMES — fall through
  }

  const indexPath = "packages/cli/src/index.ts";
  const src = await readFile(indexPath, "utf-8");
  const names = new Set<string>();
  for (const m of src.matchAll(/\.command\(\s*["']([a-z][a-z0-9-]*)["']/g)) {
    if (m[1]) names.add(m[1]);
  }
  for (const m of src.matchAll(/command:\s*["']([a-z][a-z0-9-]*)["']/g)) {
    if (m[1]) names.add(m[1]);
  }
  return [...names];
}

/**
 * Docs that show `nimbus <cmd>` invocations a reader is expected to be able to run.
 *
 * `docs/cli-reference.md` joined `docs/README.md` after it documented `nimbus mcp` — the binary
 * registers `mcp-server`, so the sentence named a command that does not exist. The landing page
 * was gated and the CLI reference, which carries twice as many invocations, was not.
 *
 * `docs/roadmap.md` is deliberately absent: it names ~50 unbuilt commands on purpose, which is
 * what an acceptance criterion for unbuilt work looks like.
 */
export const GATED_CLI_DOCS = ["docs/README.md", "docs/cli-reference.md"] as const;

if (import.meta.main) {
  const registered = await readRegisteredCommands();

  if (registered.length === 0) {
    console.error(
      `Could not extract any registered commands. ` +
        `Verify packages/cli/src/commands/registry.ts exports COMMAND_NAMES, ` +
        `or update the fallback regex in readRegisteredCommands().`,
    );
    process.exit(2);
  }

  let total = 0;
  let failed = false;
  for (const docPath of GATED_CLI_DOCS) {
    const cmds = extractReadmeCliCommands(await readFile(docPath, "utf-8"));
    total += cmds.length;
    const result = validateReadmeCommands(cmds, registered);
    if (!result.ok) {
      failed = true;
      console.error(`${docPath} references ${result.missing.length} unregistered command(s):`);
      for (const c of result.missing) console.error(`   - nimbus ${c}`);
      console.error(`Either register the command, or correct the reference in ${docPath}.`);
    }
  }
  if (failed) process.exit(1);
  console.log(
    `All ${total} \`nimbus <cmd>\` references across ${GATED_CLI_DOCS.length} docs match the CLI registry.`,
  );
}
