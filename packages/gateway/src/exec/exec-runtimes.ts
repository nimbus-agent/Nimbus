import { extname } from "node:path";

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

export interface ExecRuntime {
  readonly id: string;
  /** Absolute path to the interpreter, or null when it is not installed. */
  detect(): string | null;
  argvFor(scriptPath: string): { cmd: string; args: string[] };
}

const BUN_RUNTIME: ExecRuntime = {
  id: "bun",
  // The Gateway IS a Bun process, so the interpreter is always the one already running us. That is
  // why bun needs no PATH probing and can never be "allowed but missing" -- a property that will
  // NOT hold for a future Deno or Python entry, which must really probe.
  detect: () => process.execPath,
  argvFor: (scriptPath) => ({ cmd: process.execPath, args: ["run", scriptPath] }),
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
