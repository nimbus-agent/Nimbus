import { dirname, extname } from "node:path";

/**
 * A named error so a caller can distinguish refusal reasons without matching on message text.
 * Every refusal here happens BEFORE the owner is prompted -- the gate must never ask a human to
 * approve a run that could not have started.
 */
export class ExecRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecRuntimeError";
  }
}

/**
 * Ceiling on an inline body, in UTF-16 code units.
 *
 * The body travels as a command-line argument, and the Windows helper's buffer is
 * `wchar_t cmdline[32768]` covering the interpreter path, every flag and the body plus its quoting
 * expansion. 16,384 leaves room for all of that with margin, and matches `BODY_MAX_PROSE` elsewhere
 * in the tree. Exceeding it is a NAMED refusal before consent, never a silent truncation — running
 * a prefix of someone's script is far worse than refusing the whole of it.
 */
export const MAX_INLINE_CODE_UNITS = 16_384;

export interface ExecRuntime {
  readonly id: string;
  /** Absolute path to the interpreter, or null when it is not installed. */
  detect(): string | null;
  /**
   * Argv that executes `code` INLINE — no script file anywhere.
   *
   * Measured on Windows: under the AppContainer, bun can read a granted file, list its cwd, report
   * `process.cwd()`, and even `import()` and run that same file successfully — but naming it as the
   * ENTRY POINT (`bun s.ts` / `bun run s.ts`) fails with `CouldntReadCurrentDirectory`. Its startup
   * path for a file entry point touches something the sandbox denies; `-e` does not.
   *
   * Passing the body inline is what makes Windows work, and it is better on its own terms: there is
   * no scratch file to write, grant, or clean up, and the bytes the owner approved are the bytes
   * handed to the interpreter with no file in between for anything to swap.
   */
  argvFor(code: string): { cmd: string; args: string[] };
  /**
   * Paths the sandbox must grant READ so the child can load this interpreter at all.
   *
   * Not an optimisation: on Windows the AppContainer helper writes an ACE per granted path, so a
   * binary outside every grant is simply unreadable and the child dies before running a line — exit
   * 68, no stdout, no stderr. Linux happens to hide this because bwrap binds the system tree by
   * default, which is exactly why it must be stated explicitly rather than left to luck.
   */
  requiredReadPaths(): string[];
}

const BUN_RUNTIME: ExecRuntime = {
  id: "bun",
  // The Gateway IS a Bun process, so the interpreter is always the one already running us. That is
  // why bun needs no PATH probing and can never be "allowed but missing" -- a property that will
  // NOT hold for a future Deno or Python entry, which must really probe.
  detect: () => process.execPath,
  argvFor: (code) => ({ cmd: process.execPath, args: ["-e", code] }),
  requiredReadPaths: () => {
    const binDir = dirname(process.execPath);
    // macOS additionally needs the runtime HOME (`~/.bun`), where the SBPL-confined child resolves
    // its own support files. Windows must NOT get it: `~/.bun` carries `install/cache` with
    // thousands of entries, and the helper writes one ACE per granted path -- granting it there
    // made every spawn hang until the harness killed it. Measured in
    // `test/integration/platform/sandbox/sandbox-wrapper-spawn.test.ts`; do not "simplify" this
    // into an unconditional parent grant.
    return process.platform === "darwin" ? [binDir, dirname(binDir)] : [binDir];
  },
};

const REGISTRY: ReadonlyMap<string, ExecRuntime> = new Map([["bun", BUN_RUNTIME]]);

/**
 * Extension -> runtime id. Adding Python later adds a row here; it does NOT change what an
 * already-mapped extension does.
 *
 * An unmapped extension is REJECTED rather than defaulted to the sole entry. With one runtime
 * wired a fallback would run `script.py` through bun and fail with a confusing parse error today,
 * and would silently change meaning the day a Python entry lands. Rejecting is correct in both.
 */
const EXTENSION_MAP: ReadonlyMap<string, string> = new Map([
  [".ts", "bun"],
  [".js", "bun"],
  [".mjs", "bun"],
]);

export function resolveRuntimeById(id: string): ExecRuntime {
  const rt = REGISTRY.get(id.trim().toLowerCase());
  if (rt === undefined) {
    throw new ExecRuntimeError("ERR_EXEC_UNKNOWN_RUNTIME", `unknown runtime: ${id}`);
  }
  return rt;
}

export function resolveRuntimeForFile(filePath: string): ExecRuntime {
  const ext = extname(filePath).toLowerCase();
  const id = EXTENSION_MAP.get(ext);
  if (id === undefined) {
    throw new ExecRuntimeError(
      "ERR_EXEC_UNKNOWN_EXTENSION",
      `no runtime is registered for extension "${ext}"`,
    );
  }
  return resolveRuntimeById(id);
}

/** Fail before consent when a registered runtime is not installed on this machine. */
export function requireInstalled(rt: ExecRuntime): string {
  const bin = rt.detect();
  if (bin === null) {
    throw new ExecRuntimeError(
      "ERR_EXEC_RUNTIME_NOT_INSTALLED",
      `runtime "${rt.id}" is registered but not installed`,
    );
  }
  return bin;
}
