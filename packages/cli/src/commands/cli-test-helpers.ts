// cli-test-helpers.ts — shared fixtures for the CLI command unit tests.
// Not a *.test.ts file, so Bun never runs it directly; it is imported by the
// command test suites to keep the IPC stub + stdout capture in one place.

export interface CallRecord {
  method: string;
  params: unknown;
}

/** A queued JSON-RPC `call` stub: records every call and returns/throws the next queued value. */
export function makeQueuedCall(responseQueue: readonly unknown[]): {
  call: <T>(method: string, params?: unknown) => Promise<T>;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  let idx = 0;
  const call = async <T>(method: string, params?: unknown): Promise<T> => {
    calls.push({ method, params });
    if (idx >= responseQueue.length) {
      throw new Error(`Unexpected call: ${method} (response queue exhausted)`);
    }
    const r = responseQueue[idx];
    idx += 1;
    if (r instanceof Error) throw r;
    return r as T;
  };
  return { call, calls };
}

/** Runs `fn` with `process.stdout.write` captured, returning everything written to stdout. */
export async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}
