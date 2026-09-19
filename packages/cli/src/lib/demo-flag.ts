/**
 * The global `--demo` flag (spec § 3.1, invariant I41). Applied in `index.ts` BEFORE any path is
 * resolved: the CLI opens its file logger under `logDir` ahead of dispatch, so a flag handled
 * later would already have written into the REAL install. Mutates `env` on purpose — every later
 * `getCliPlatformPaths()` call, and the gateway `nimbus start` spawns (which inherits this
 * process's environment), must see `NIMBUS_DEMO=1`.
 *
 * Only an exact `--demo` token counts; no command defines its own `--demo` (checked 2026-09-18),
 * so stripping it globally shadows nothing.
 */
export const DEMO_FLAG = "--demo";

export function applyDemoFlag(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  if (!argv.includes(DEMO_FLAG)) return [...argv];
  env["NIMBUS_DEMO"] = "1";
  return argv.filter((a) => a !== DEMO_FLAG);
}
