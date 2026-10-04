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
  onChunk?: (chunk: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) return;
      const chunk = decoder.decode(value, { stream: true });
      onChunk?.(chunk);
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

/** The output streams a marker watch reads. */
export interface MarkerStreams {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

export interface MarkerWatchHooks {
  /** Runs once, synchronously, at the first sighting and before `matched` resolves. */
  onFirstMatch?: () => void;
  /** Receives each decoded stderr chunk as it is read. */
  onStderrChunk?: (chunk: string) => void;
}

export interface MarkerWatch {
  /** Resolves at the first sighting; never rejects, and stays pending if the marker never shows. */
  readonly matched: Promise<void>;
  isMatched(): boolean;
}

/**
 * Reads a child's stdout AND stderr for `marker` and reports the first sighting on either stream:
 * the TUI writes its first-frame marker to stderr, the gateway its ready banner to stdout. Each
 * stream is read until it shows the marker or ends; once either has shown it, the other stops at
 * its next chunk. Deadlines and exit handling stay with the caller, because they differ per bench.
 */
export function watchForMarker(
  streams: MarkerStreams,
  marker: RegExp,
  hooks: MarkerWatchHooks = {},
): MarkerWatch {
  const ac = new AbortController();
  let matched = false;
  let resolveMatched!: () => void;
  const matchedPromise = new Promise<void>((resolve) => {
    resolveMatched = resolve;
  });
  const onMatch = (): void => {
    if (matched) return;
    matched = true;
    hooks.onFirstMatch?.();
    ac.abort();
    resolveMatched();
  };
  void readUntilMatch(streams.stdout, marker, onMatch, ac.signal);
  void readUntilMatch(streams.stderr, marker, onMatch, ac.signal, hooks.onStderrChunk);
  return { matched: matchedPromise, isMatched: () => matched };
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
  let elapsed = 0;
  const watch = watchForMarker(proc, marker, {
    onFirstMatch: () => {
      elapsed = performance.now() - start;
    },
  });

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const racers: Promise<unknown>[] = [
    watch.matched,
    new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        if (!watch.isMatched()) reject(new Error(`spawn-and-time timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
    proc.exited.then((code) => {
      if (!watch.isMatched() && code !== 0) {
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

  if (!watch.isMatched()) {
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
