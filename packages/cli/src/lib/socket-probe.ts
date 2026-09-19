/**
 * The one "is a gateway actually answering on this socket?" probe the CLI uses before it trusts
 * a `gateway.json` state file: `nimbus start` (reuse vs. start fresh) and `stopAndWaitForExit`
 * (signal vs. treat as stale) both ask it.
 *
 * The client is INJECTED rather than constructed here, because the two callers must reach two
 * different `IPCClient` bindings: `start.ts` goes through `../ipc-client/index.ts`, which the CLI
 * command tests replace via `mock.module` to script reachability, while `stop-and-wait.ts` must
 * probe the REAL socket even inside that combined, mock-contaminated test run (the same reason it
 * reads state through `gw-state-helpers.ts` rather than `gateway-process.ts`).
 */
/** How long either caller waits for a state file's socket to accept a connection. */
export const SOCKET_PROBE_TIMEOUT_MS = 2000;

export interface ProbeClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
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
