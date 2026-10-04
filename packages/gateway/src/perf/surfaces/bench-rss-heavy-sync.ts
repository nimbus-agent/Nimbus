import type { BenchRunOptions } from "../types.ts";
import { type GatewayRssRunOptions, measureGatewayRss } from "./bench-rss-shared.ts";

const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 250;

export type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;

export interface RssHeavySyncRunOptions extends GatewayRssRunOptions {
  ipcCall?: IpcCallFn;
}

function defaultIpcCall(_method: string, _params: unknown): Promise<unknown> {
  return Promise.reject(new Error("default IPC client not wired — pass runOpts.ipcCall in tests"));
}

/** Starts a full sync of drive, gmail and github at once; a sync that fails never fails the bench. */
async function fireFullSyncs(ipc: IpcCallFn, signal: AbortSignal): Promise<void> {
  const fire = async (svc: string): Promise<void> => {
    if (signal.aborted) return;
    try {
      await ipc("connector.sync", { service: svc, full: true });
    } catch {
      /* a partially-stubbed test env or sync error doesn't fail the bench */
    }
  };
  await Promise.allSettled([fire("drive"), fire("gmail"), fire("github")]);
}

export function runRssHeavySyncOnce(
  _opts: BenchRunOptions,
  runOpts: RssHeavySyncRunOptions = {},
): Promise<number[]> {
  const ipc = runOpts.ipcCall ?? defaultIpcCall;
  return measureGatewayRss(
    runOpts,
    { durationMs: DEFAULT_DURATION_MS, intervalMs: DEFAULT_INTERVAL_MS },
    (signal) => fireFullSyncs(ipc, signal),
  );
}
