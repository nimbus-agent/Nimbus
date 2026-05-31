import { resolve } from "node:path";

import { spawnGatewayForBench } from "../gateway-spawn-bench.ts";
import { sampleRss } from "../rss-sampler.ts";
import type { BenchRunOptions } from "../types.ts";

const READY_MARKER = /\[gateway\] ready/;
const DEFAULT_DURATION_MS = 60_000;
const DEFAULT_INTERVAL_MS = 250;

export type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;

export interface RssHeavySyncRunOptions {
  spawn?: typeof Bun.spawn;
  gatewayEntry?: string;
  durationMs?: number;
  intervalMs?: number;
  pidusage?: (pid: number) => Promise<{ memory: number }>;
  ipcCall?: IpcCallFn;
}

function defaultGatewayEntry(): string {
  return resolve(import.meta.dir, "..", "..", "index.ts");
}

async function defaultIpcCall(_method: string, _params: unknown): Promise<unknown> {
  throw new Error("default IPC client not wired — pass runOpts.ipcCall in tests");
}

export async function runRssHeavySyncOnce(
  _opts: BenchRunOptions,
  runOpts: RssHeavySyncRunOptions = {},
): Promise<number[]> {
  const durationMs = runOpts.durationMs ?? DEFAULT_DURATION_MS;
  const intervalMs = runOpts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const entry = runOpts.gatewayEntry ?? defaultGatewayEntry();
  const ipc = runOpts.ipcCall ?? defaultIpcCall;

  const result = await spawnGatewayForBench<void, { samples: number[] }>({
    cmd: process.execPath,
    args: [entry],
    readyMarker: READY_MARKER,
    ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
    workload: async ({ signal }) => {
      const fire = async (svc: string): Promise<void> => {
        if (signal.aborted) return;
        try {
          await ipc("connector.sync", { service: svc, full: true });
        } catch {
          /* a partially-stubbed test env or sync error doesn't fail the bench */
        }
      };
      await Promise.allSettled([fire("drive"), fire("gmail"), fire("github")]);
      await new Promise<void>((resolve_) => {
        const t = setTimeout(resolve_, durationMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            resolve_();
          },
          { once: true },
        );
      });
    },
    sampler: ({ pid, signal }) =>
      sampleRss({
        pid,
        durationMs,
        intervalMs,
        signal,
        ...(runOpts.pidusage !== undefined && { pidusage: runOpts.pidusage }),
      }),
  });
  return result.samplerResult?.samples ?? [];
}
