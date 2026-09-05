const DEFAULT_READY_TIMEOUT_MS = 30_000;

export interface SpawnGatewayForBenchOptions<W, S = void> {
  cmd: string;
  args: string[];
  readyMarker: RegExp;
  readyTimeoutMs?: number;
  workload: (ctx: { pid: number; signal: AbortSignal }) => Promise<W>;
  sampler?: (ctx: { pid: number; signal: AbortSignal }) => Promise<S>;
  env?: Record<string, string>;
  spawn?: typeof Bun.spawn;
}

export interface SpawnGatewayResult<W, S> {
  workloadResult: W;
  samplerResult: S | undefined;
  totalMs: number;
}

interface ProcSubset {
  pid: number;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}

function spawnChild<W, S>(opts: SpawnGatewayForBenchOptions<W, S>): ProcSubset {
  const spawn = opts.spawn ?? Bun.spawn;
  return spawn([opts.cmd, ...opts.args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // Matches how the Gateway spawns in production, so the measured cost is the real one.
    windowsHide: true,
    ...(opts.env !== undefined && { env: { ...process.env, ...opts.env } }),
  });
}

const STDERR_BUFFER_LINES = 20;

class StderrRing {
  private readonly lines: string[] = [];
  push(s: string): void {
    for (const line of s.split("\n")) {
      if (line.length === 0) continue;
      this.lines.push(line);
      if (this.lines.length > STDERR_BUFFER_LINES) this.lines.shift();
    }
  }
  tail(): string {
    return this.lines.length === 0
      ? ""
      : `\n--- last ${this.lines.length} stderr lines ---\n${this.lines.join("\n")}`;
  }
}

async function readUntilMatch(
  stream: ReadableStream<Uint8Array>,
  marker: RegExp,
  onMatch: () => void,
  signal: AbortSignal,
  stderrRing?: StderrRing,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      if (stderrRing !== undefined) stderrRing.push(chunk);
      buf += chunk;
      if (marker.test(buf)) {
        onMatch();
        return;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

async function waitForMarker(
  proc: ProcSubset,
  marker: RegExp,
  timeoutMs: number,
  stderrRing: StderrRing,
): Promise<void> {
  const ac = new AbortController();
  let matched = false;
  let resolveMatched!: () => void;
  const matchedPromise = new Promise<void>((resolve) => {
    resolveMatched = resolve;
  });
  const onMatch = (): void => {
    if (matched) return;
    matched = true;
    ac.abort();
    resolveMatched();
  };
  void readUntilMatch(proc.stdout, marker, onMatch, ac.signal);
  void readUntilMatch(proc.stderr, marker, onMatch, ac.signal, stderrRing);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      matchedPromise,
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`gateway not ready in ${timeoutMs}ms${stderrRing.tail()}`)),
          timeoutMs,
        );
      }),
      proc.exited.then((code) => {
        if (!matched) {
          throw new Error(
            `child exited with code ${code} before marker matched${stderrRing.tail()}`,
          );
        }
      }),
    ]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
  if (!matched) {
    throw new Error(`gateway not ready in ${timeoutMs}ms${stderrRing.tail()}`);
  }
}

export async function spawnGatewayForBench<W, S = void>(
  opts: SpawnGatewayForBenchOptions<W, S>,
): Promise<SpawnGatewayResult<W, S>> {
  const proc = spawnChild(opts);
  const timeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const stderrRing = new StderrRing();
  try {
    await waitForMarker(proc, opts.readyMarker, timeoutMs, stderrRing);
  } catch (err) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
    throw err;
  }

  const ac = new AbortController();
  const start = performance.now();
  let workloadResult: W;
  let samplerResult: S | undefined;
  try {
    if (opts.sampler === undefined) {
      workloadResult = await opts.workload({ pid: proc.pid, signal: ac.signal });
    } else {
      const samplerPromise = opts.sampler({ pid: proc.pid, signal: ac.signal });
      workloadResult = await opts.workload({ pid: proc.pid, signal: ac.signal });
      ac.abort();
      samplerResult = await samplerPromise;
    }
  } finally {
    ac.abort();
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      await proc.exited;
    } catch {
      /* ignore */
    }
  }
  const totalMs = performance.now() - start;
  return { workloadResult, samplerResult, totalMs };
}
