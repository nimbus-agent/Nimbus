import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The roles the gateway executable can be invoked in, selected by `process.argv[2]`.
 *
 * A compiled binary ships alone: it has no `bun` on PATH and no source tree beside it, so the only
 * thing it can spawn is itself. Every child process the gateway starts therefore re-executes this
 * same executable with one of these sentinels.
 */
export const ROLE_SENTINELS = {
  sandbox: "__nimbus-sandbox",
  connector: "__nimbus-connector",
} as const;

export type SelfRole = keyof typeof ROLE_SENTINELS;

export interface RuntimeLayout {
  /** `process.execPath`: the bun binary in a dev tree, the gateway binary when compiled. */
  readonly execPath: string;
  /** The directory this module reports living in (`import.meta.dir`). */
  readonly moduleDir: string;
  /** Absolute path to `packages/gateway/src/index.ts`. Only used in a dev tree. */
  readonly gatewayEntry: string;
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_RUNTIME_LAYOUT: RuntimeLayout = {
  execPath: process.execPath,
  moduleDir: MODULE_DIR,
  gatewayEntry: resolve(MODULE_DIR, "..", "index.ts"),
};

/**
 * True when running inside a `bun build --compile` executable.
 *
 * Measured values of `import.meta.dir` there: `/$bunfs/root` on POSIX and `B:\~BUN\root` on
 * Windows. Both are virtual roots — walking up from them yields paths that do not exist, which is
 * why every source-relative asset and script path in the gateway breaks in a released binary.
 */
export function isCompiledBinary(layout: RuntimeLayout = DEFAULT_RUNTIME_LAYOUT): boolean {
  const dir = layout.moduleDir.replaceAll("\\", "/");
  return dir.startsWith("/$bunfs/") || /^[A-Za-z]:\/~BUN\//.test(dir);
}

/**
 * Build the `command` + `args` that re-execute THIS program in one of its non-gateway roles.
 *
 * The child sees the same `process.argv.slice(2)` in both runtime shapes: compiled, bun injects its
 * own argv[0]/argv[1] pair ahead of the user arguments; in a dev tree the gateway entry script
 * occupies argv[1]. Callers therefore never branch on the runtime shape.
 */
export function selfSpawn(
  role: SelfRole,
  args: readonly string[] = [],
  layout: RuntimeLayout = DEFAULT_RUNTIME_LAYOUT,
): { command: string; args: string[] } {
  const sentinel = ROLE_SENTINELS[role];
  return isCompiledBinary(layout)
    ? { command: layout.execPath, args: [sentinel, ...args] }
    : { command: layout.execPath, args: [layout.gatewayEntry, sentinel, ...args] };
}
