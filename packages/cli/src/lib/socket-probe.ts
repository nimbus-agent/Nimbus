import net from "node:net";

/**
 * The one "is a gateway actually answering on this socket?" probe the CLI uses before it trusts
 * a `gateway.json` state file: `nimbus start` (reuse vs. start fresh) and `stopAndWaitForExit`
 * (signal vs. treat as stale) both ask it.
 *
 * The client is INJECTED rather than constructed here, because the two callers need two different
 * clients. `start.ts` passes an `IPCClient` from `../ipc-client/index.ts`, which the CLI command
 * tests replace via `mock.module` to script reachability. `stop-and-wait.ts` must probe the REAL
 * socket even inside that combined, mock-contaminated test run, and importing `IPCClient` straight
 * from `@nimbus-dev/client` does not escape the mock (Bun's `mock.module` follows the facade's
 * re-export and shadows the package too — observed: the combined run signalled a pid whose socket
 * had no listener). So it passes {@link rawSocketClient}, which shares nothing with that module.
 */

/** How long either caller waits for a state file's socket to accept a connection. */
export const SOCKET_PROBE_TIMEOUT_MS = 2000;

export interface ProbeClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * A bare `node:net` connection to `socketPath` — a Windows named pipe or a unix socket path, the
 * same two transports the gateway listens on (`@nimbus-dev/client` connects a Windows pipe exactly
 * this way). It speaks no protocol: connecting is the whole question, and it hangs up at once.
 */
export function rawSocketClient(socketPath: string): ProbeClient {
  let sock: net.Socket | undefined;
  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        const s = net.createConnection(socketPath);
        sock = s;
        s.once("connect", () => resolve());
        s.once("error", reject);
      }),
    disconnect: async () => {
      sock?.destroy();
    },
  };
}

export async function probeSocketReachable(
  client: ProbeClient,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("probe timeout"));
      }, timeoutMs);
    });
    await Promise.race([client.connect(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await client.disconnect().catch(() => {});
  }
}
