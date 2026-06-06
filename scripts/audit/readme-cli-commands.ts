import { readFile } from "node:fs/promises";

const STOP_WORDS = new Set(["--version", "--help", "-v", "-h"]);

export function extractReadmeCliCommands(markdown: string): string[] {
  const found = new Set<string>();
  const pattern = /(?<!\w)nimbus\s+([a-z][a-z0-9-]*)/g;
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

if (import.meta.main) {
  const readmePath = "docs/README.md";
  const readme = await readFile(readmePath, "utf-8");
  const readmeCmds = extractReadmeCliCommands(readme);
  const registered = await readRegisteredCommands();

  if (registered.length === 0) {
    console.error(
      `Could not extract any registered commands. ` +
        `Verify packages/cli/src/commands/registry.ts exports COMMAND_NAMES, ` +
        `or update the fallback regex in readRegisteredCommands().`,
    );
    process.exit(2);
  }

  const result = validateReadmeCommands(readmeCmds, registered);
  if (!result.ok) {
    console.error(`README references ${result.missing.length} unregistered command(s):`);
    for (const c of result.missing) console.error(`   - nimbus ${c}`);
    console.error(`\nEither register the command, or remove the reference from docs/README.md.`);
    process.exit(1);
  }
  console.log(
    `All ${readmeCmds.length} README \`nimbus <cmd>\` references match the CLI registry.`,
  );
}
