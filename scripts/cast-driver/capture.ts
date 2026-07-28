import type { CastChunk } from "./cast-writer.ts";

export interface SpawnCaptureOpts {
  readonly cmd: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Working directory for the child. Omitted -> inherit the recorder's cwd. */
  readonly cwd?: string;
}

export interface CaptureResult {
  readonly chunks: ReadonlyArray<CastChunk>;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export async function spawnCapture(opts: SpawnCaptureOpts): Promise<CaptureResult> {
  const startMs = Date.now();
  const chunks: Array<{ tMs: number; data: string }> = [];
  let stderr = "";
  let timedOut = false;

  const proc = Bun.spawn({
    cmd: [...opts.cmd],
    env: opts.env as Record<string, string>,
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);

  const decoder = new TextDecoder("utf-8", { fatal: false });
  const stdoutReader = proc.stdout.getReader();
  const readStdout = (async (): Promise<void> => {
    while (true) {
      const { value, done } = await stdoutReader.read();
      if (done) break;
      if (value !== undefined && value.length > 0) {
        chunks.push({ tMs: Date.now() - startMs, data: decoder.decode(value, { stream: true }) });
      }
    }
    chunks.push({ tMs: Date.now() - startMs, data: decoder.decode() });
  })();

  const stderrReader = proc.stderr.getReader();
  const readStderr = (async (): Promise<void> => {
    const dec = new TextDecoder("utf-8", { fatal: false });
    while (true) {
      const { value, done } = await stderrReader.read();
      if (done) break;
      if (value !== undefined && value.length > 0) {
        stderr += dec.decode(value, { stream: true });
      }
    }
    stderr += dec.decode();
  })();

  const exitCode = await proc.exited;
  await Promise.all([readStdout, readStderr]);
  clearTimeout(timeoutHandle);

  return { chunks: chunks.filter((c) => c.data.length > 0), stderr, exitCode, timedOut };
}
