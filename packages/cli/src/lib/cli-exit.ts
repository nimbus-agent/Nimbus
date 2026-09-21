/**
 * A command's request to end the process with `code` AFTER it has already written its own message.
 *
 * Thrown instead of calling `process.exit(code)` so that a caller running several commands in one
 * process — `nimbus wow`, `nimbus demo`, `nimbus init`'s tour hook — can survive one of them
 * failing. It also lets `finally` blocks (IPC disconnects) run, which `process.exit` skipped.
 */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    if (!Number.isInteger(code) || code < 1 || code > 255) {
      throw new RangeError(`CliExit code must be an integer in 1..255, got ${String(code)}`);
    }
    super(`exit ${String(code)}`);
    this.name = "CliExit";
    this.code = code;
  }
}

export type TopLevelErrorClass =
  | { readonly kind: "cli-exit"; readonly code: number }
  | { readonly kind: "error"; readonly message: string };

/** `main()`'s catch decides with this: a `CliExit` is silent, anything else is printed. */
export function classifyTopLevelError(e: unknown): TopLevelErrorClass {
  if (e instanceof CliExit) return { kind: "cli-exit", code: e.code };
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
}
