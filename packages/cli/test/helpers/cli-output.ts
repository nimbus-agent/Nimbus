// packages/cli/test/helpers/cli-output.ts
//
// Captures process.stdout / process.stderr / console.* for the duration
// of a test. Restore() must be called in afterAll so adjacent test files
// in the same `bun test` process aren't affected by the stubs.
//
// Node convention routing: log/info/debug -> stdout buffer, warn/error
// -> stderr buffer.

export interface CapturedOutput {
  readonly stdout: string;
  readonly stderr: string;
  reset(): void;
  restore(): void;
}

/**
 * Capture `console.*` output for the duration of a test.
 *
 * IMPORTANT: We intercept only `console.log` / `console.info` /
 * `console.debug` / `console.warn` / `console.error` — NOT
 * `process.stdout.write` / `process.stderr.write`. Bun's test runner
 * itself writes its progress / pass-fail output via the raw `process.*`
 * streams, so swallowing those would hide the test results.
 *
 * CLI command code routes user-facing output through `console.log` /
 * `console.error`, which is what these helpers care about.
 *
 * `restore()` MUST be called in `afterAll` so adjacent test files in
 * the same `bun test` process aren't affected by the stubs.
 */
export function captureOutput(): CapturedOutput {
  let stdoutBuf = "";
  let stderrBuf = "";
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const origInfo = console.info;
  const origDebug = console.debug;

  const writeToStdout = (...args: unknown[]): void => {
    stdoutBuf += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };
  const writeToStderr = (...args: unknown[]): void => {
    stderrBuf += `${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`;
  };

  console.log = writeToStdout;
  console.info = writeToStdout;
  console.debug = writeToStdout;
  console.warn = writeToStderr;
  console.error = writeToStderr;

  return {
    get stdout(): string {
      return stdoutBuf;
    },
    get stderr(): string {
      return stderrBuf;
    },
    reset(): void {
      stdoutBuf = "";
      stderrBuf = "";
    },
    restore(): void {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      console.info = origInfo;
      console.debug = origDebug;
    },
  };
}
