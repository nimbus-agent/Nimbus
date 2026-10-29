import {
  DEFAULT_RUNTIME_LAYOUT,
  isCompiledBinary,
  type RuntimeLayout,
  selfSpawn,
} from "../platform/runtime-layout.ts";

/*
 * DEPENDENCY-FREE on purpose (beyond the runtime layout): the eval role imports this through its
 * spec builder, and its module graph must reach no db/, vault/, ipc/ or egress/ module (I49).
 * `extension-runtime.ts` imports the stores; this module must never import it.
 */

/**
 * The dev-tree form of the `__nimbus-extension` role, inline. In a dev tree the self-role would be
 * `bun <gateway>/src/index.ts __nimbus-extension <entry>`, and the confined child cannot load the
 * gateway's own source: it is not granted, and on Windows Bun's loader needs FILE_WRITE_ATTRIBUTES
 * on every module it opens. This does exactly what `run-extension-entry.ts` does, with no file of
 * its own to load. FULLY STATIC: the entry travels as the one argument after the code
 * (`bun -e <code> <entry>` hands the child `process.argv = [bun, <entry>]`), never interpolated.
 * It carries no backslash (an escape in `-e` code reached the Windows child mangled), which is why
 * the message and the stack are two `console.error` calls rather than one joined string.
 * A compiled binary does not honour `-e`, and runs the real self-role instead. That compiled
 * path is REASONED from a compiled probe (a `bun build --compile` binary importing a file from a
 * directory the AppContainer grants write), not exercised end to end: the e2e runs a dev tree.
 */
const DEV_EXTENSION_ROLE_INLINE = [
  'const { isAbsolute } = await import("node:path");',
  'const { pathToFileURL } = await import("node:url");',
  "const entry = process.argv.length === 2 ? process.argv[1] : undefined;",
  'if (entry === undefined || entry === "" || !isAbsolute(entry)) {',
  '  console.error("nimbus-gateway: extension role needs an absolute entry path");',
  "  process.exit(2);",
  "}",
  "try {",
  "  await import(pathToFileURL(entry).href);",
  "} catch (err) {",
  '  console.error("nimbus-gateway: " + (err instanceof Error ? err.message : String(err)));',
  "  if (err instanceof Error && err.stack !== undefined) console.error(err.stack);",
  "  process.exit(2);",
  "}",
].join("\n");

/**
 * Bun flags for the dev-tree form, ahead of `-e`. Neither is the boundary — the fresh per-spawn
 * stage is (`extension-stage.ts`) — they are hardening: `--no-env-file` stops a `.env` in the
 * working directory being loaded into the child's environment, and `--no-install` stops a missing
 * bare import from auto-installing code from a registry.
 */
const DEV_EXTENSION_BUN_FLAGS = ["--no-env-file", "--no-install"] as const;

/**
 * The compiled/dev command that runs an extension entry, UNWRAPPED — shared by the run builder
 * (`extension-runtime.ts`) and the eval builder (`eval/eval-spawn-spec.ts`), each of which wraps
 * it through the sandbox. D33(a) confines `selfSpawn("extension")` to this module and D38(b)
 * confines this function to those two callers.
 */
export function extensionEntryCommand(
  entryPath: string,
  layoutOverride: RuntimeLayout | undefined,
): { command: string; args: string[] } {
  const layout = layoutOverride ?? DEFAULT_RUNTIME_LAYOUT;
  return isCompiledBinary(layout)
    ? selfSpawn("extension", [entryPath], layout)
    : {
        command: layout.execPath,
        args: [...DEV_EXTENSION_BUN_FLAGS, "-e", DEV_EXTENSION_ROLE_INLINE, entryPath],
      };
}
