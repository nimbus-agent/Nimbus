import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { RequestHandler } from "msw";
import { type SetupServer, setupServer } from "msw/node";

import { spawnGatewayForBench } from "../gateway-spawn-bench.ts";
import type { BenchRunOptions, CorpusTier } from "../types.ts";

const READY_MARKER = /\[gateway\] ready/;
export const SAMPLES_PER_RUN = 5;

export type IpcCallFn = (method: string, params: unknown) => Promise<unknown>;

export interface SyncThroughputRunOptions {
  spawn?: typeof Bun.spawn;
  gatewayEntry?: string;
  ipcCall?: IpcCallFn;
  mswServer?: SetupServer;
}

interface SyncThroughputServiceConfig {
  service: string;
  tmpDirPrefix: string;
  handlers: (tier: CorpusTier) => RequestHandler[];
}

function defaultGatewayEntry(): string {
  return resolve(import.meta.dir, "..", "..", "index.ts");
}

async function defaultIpcCall(_method: string, _params: unknown): Promise<unknown> {
  throw new Error("IPC client wiring deferred; pass runOpts.ipcCall in tests");
}

export async function runSyncThroughputOnce(
  config: SyncThroughputServiceConfig,
  opts: BenchRunOptions,
  runOpts: SyncThroughputRunOptions = {},
): Promise<number[]> {
  const tier = opts.corpus ?? "small";
  const entry = runOpts.gatewayEntry ?? defaultGatewayEntry();
  const ipc = runOpts.ipcCall ?? defaultIpcCall;
  const countSql = `SELECT COUNT(*) AS c FROM item WHERE service = '${config.service}'`;

  const samples: number[] = [];
  for (let i = 0; i < SAMPLES_PER_RUN; i += 1) {
    const home = mkdtempSync(join(tmpdir(), config.tmpDirPrefix));
    const server = runOpts.mswServer ?? setupServer(...config.handlers(tier));
    server.listen({ onUnhandledRequest: "warn" });
    try {
      const result = await spawnGatewayForBench<{ items: number; ms: number }, void>({
        cmd: process.execPath,
        args: [entry],
        readyMarker: READY_MARKER,
        env: { NIMBUS_HOME: home },
        ...(runOpts.spawn !== undefined && { spawn: runOpts.spawn }),
        workload: async () => {
          const before = (await ipc("index.querySql", {
            sql: countSql,
            params: [],
          })) as Array<{ c: number }>;
          const t0 = performance.now();
          await ipc("connector.sync", { service: config.service, full: true });
          const ms = performance.now() - t0;
          const after = (await ipc("index.querySql", {
            sql: countSql,
            params: [],
          })) as Array<{ c: number }>;
          return {
            items: (after[0]?.c ?? 0) - (before[0]?.c ?? 0),
            ms,
          };
        },
      });
      const itemsPerSec =
        result.workloadResult.ms <= 0
          ? 0
          : result.workloadResult.items / (result.workloadResult.ms / 1000);
      samples.push(itemsPerSec);
    } finally {
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }
  return samples;
}
