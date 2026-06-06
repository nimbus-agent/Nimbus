/**
 * In-memory capture of `process.stdout`/`process.stderr` writes for CLI command
 * tests, optionally trapping `process.exit()` as a throw so exit paths can be
 * asserted. Call {@link StreamCapture.install} in `beforeEach` and
 * {@link StreamCapture.restore} in `afterEach`/`afterAll`.
 *
 * Destructure with renames to keep existing call sites terse, e.g.
 * `const { stdoutChunks, install: installStreamCapture, restore: restoreStreams } =
 *    createStreamCapture({ captureExit: true });`
 */
export interface StreamCapture {
  readonly stdoutChunks: string[];
  readonly stderrChunks: string[];
  install(): void;
  restore(): void;
}

export function createStreamCapture(opts: { captureExit?: boolean } = {}): StreamCapture {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origExit = process.exit.bind(process);

  return {
    stdoutChunks,
    stderrChunks,
    install(): void {
      process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stderr.write;
      if (opts.captureExit) {
        process.exit = ((code?: number): never => {
          throw new Error(`process.exit(${code ?? ""})`);
        }) as typeof process.exit;
      }
    },
    restore(): void {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      if (opts.captureExit) {
        process.exit = origExit;
      }
    },
  };
}
