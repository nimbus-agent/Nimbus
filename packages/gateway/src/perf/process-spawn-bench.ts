export type SpawnMode = "marker" | "exit";

export interface SpawnAndTimeOptions {
  cmd: string;
  args: string[];
  mode: SpawnMode;
  marker?: RegExp;
  timeoutMs?: number;
  spawn?: typeof Bun.spawn;
  env?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

interface ProcSubset {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}

async function readUntilMatch(
  stream: ReadableStream<Uint8Array>,
  marker: RegExp,
  onMatch: () => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
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

function validateMarkerOpts(opts: SpawnAndTimeOptions): void {
  if (opts.mode !== "marker") return;
  if (opts.marker === undefined) {
    throw new Error("spawnAndTimeToMarker: mode='marker' requires a marker RegExp");
  }
  if (opts.marker.global || opts.marker.sticky) {
    throw new Error("spawnAndTimeToMarker: marker must not have the g or y flag");
  }
}

function spawnChild(opts: SpawnAndTimeOptions): ProcSubset {
  const spawn = opts.spawn ?? Bun.spawn;
  const stdio = opts.mode === "exit" ? "ignore" : "pipe";
  const child = spawn([opts.cmd, ...opts.args], {
    stdin: "ignore",
    stdout: stdio,
    stderr: stdio,
    // Matches how the Gateway spawns in production, so the measured cost is the real one.
    windowsHide: true,
    ...(opts.env !== undefined && { env: { ...process.env, ...opts.env } }),
  });
  // Bun's Subprocess types stdout/stderr as `ReadableStream | undefined` (the
  // "ignore" case); ProcSubset narrows them. The shapes are runtime-compatible
  // for what the bench reads, so bridge through unknown.
  return child as unknown as ProcSubset; // NOSONAR S4325: required Bun-Subprocess→ProcSubset bridge
}

async function runExitMode(proc: ProcSubset, start: number, timeoutMs: number): Promise<number> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      proc.exited,
      new Promise<number>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`spawn-and-time timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    const elapsed = performance.now() - start;
    if (exitCode !== 0) {
      throw new Error(`child exited with code ${exitCode}`);
    }
    return elapsed;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function runMarkerMode(
  proc: ProcSubset,
  marker: RegExp,
  start: number,
  timeoutMs: number,
): Promise<number> {
  let matched = false;
  let elapsed = 0;
  const ac = new AbortController();

  let resolveMatched!: () => void;
  const matchedPromise = new Promise<void>((resolve) => {
    resolveMatched = resolve;
  });

  const onMatch = (): void => {
    if (matched) return;
    matched = true;
    elapsed = performance.now() - start;
    ac.abort();
    resolveMatched();
  };

  void readUntilMatch(proc.stdout, marker, onMatch, ac.signal);
  void readUntilMatch(proc.stderr, marker, onMatch, ac.signal);

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const racers: Promise<unknown>[] = [
    matchedPromise,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (!matched) reject(new Error(`spawn-and-time timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
    proc.exited.then((code) => {
      if (!matched && code !== 0) {
        throw new Error(`child exited with code ${code} before marker matched`);
      }
    }),
  ];

  try {
    await Promise.race(racers);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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

  if (!matched) {
    throw new Error(`marker not found before timeout (${timeoutMs}ms)`);
  }
  return elapsed;
}

export async function spawnAndTimeToMarker(opts: SpawnAndTimeOptions): Promise<number> {
  validateMarkerOpts(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const start = performance.now();
  const proc = spawnChild(opts);
  if (opts.mode === "exit") {
    return runExitMode(proc, start, timeoutMs);
  }
  return runMarkerMode(proc, opts.marker as RegExp, start, timeoutMs);
}
