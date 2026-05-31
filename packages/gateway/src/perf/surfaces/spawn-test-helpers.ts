export function fakeSpawnExitsClean(): typeof Bun.spawn {
  return ((..._args: unknown[]) => {
    return {
      stdout: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream({
        start(c) {
          c.close();
        },
      }),
      exited: Promise.resolve(0),
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}

export interface FakeSpawnEmitsMarkerOptions {
  pid?: number;
  stdoutChunks?: string[];
  stderrChunks?: string[];
  waitForKill?: boolean;
  exitCode?: number;
  chunkDelayMs?: number;
}

function chunkedReadableStream(chunks: string[], chunkDelayMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
        await new Promise((r) => setTimeout(r, chunkDelayMs));
      }
      controller.close();
    },
  });
}

export function fakeSpawnEmitsMarker(opts: FakeSpawnEmitsMarkerOptions): typeof Bun.spawn {
  return ((..._args: unknown[]) => {
    const chunkDelayMs = opts.chunkDelayMs ?? 1;
    let killed = false;
    const waitForKill = opts.waitForKill ?? true;
    const exited = waitForKill
      ? new Promise<number>((resolve) => {
          const tick = (): void => {
            if (killed) resolve(opts.exitCode ?? 0);
            else setTimeout(tick, 5);
          };
          tick();
        })
      : Promise.resolve(opts.exitCode ?? 0);
    return {
      pid: opts.pid ?? 12345,
      stdout: chunkedReadableStream(opts.stdoutChunks ?? [], chunkDelayMs),
      stderr: chunkedReadableStream(opts.stderrChunks ?? [], chunkDelayMs),
      exited,
      kill: () => {
        killed = true;
      },
    } as unknown as ReturnType<typeof Bun.spawn>;
  }) as unknown as typeof Bun.spawn;
}
