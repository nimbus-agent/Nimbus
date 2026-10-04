import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { RequestHandler } from "msw";
import { type SetupServer, setupServer } from "msw/node";

import { type SpawnGatewayForBenchOptions, spawnGatewayForBench } from "../gateway-spawn-bench.ts";
import type { BenchRunOptions, CorpusTier } from "../types.ts";

const READY_MARKER = /\[gateway\] ready/;
export const SAMPLES_PER_RUN = 5;

/** What one sample's workload reports: the items one full sync added, and how long it took. */
type SyncWorkloadResult = { items: number; ms: number };

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

function defaultIpcCall(_method: string, _params: unknown): Promise<unknown> {
  return Promise.reject(new Error("IPC client wiring deferred; pass runOpts.ipcCall in tests"));
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
      const benchOpts: SpawnGatewayForBenchOptions<SyncWorkloadResult> = {
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
      };
      const result = await spawnGatewayForBench(benchOpts); // NOSONAR S9382: throughput samples must not overlap - each boots its own gateway and times a full sync, and an injected mswServer is shared across samples
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
