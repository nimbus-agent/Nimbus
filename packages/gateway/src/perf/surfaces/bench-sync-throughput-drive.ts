import { driveHandlers } from "../fixtures/msw-handlers.ts";
import type { BenchRunOptions } from "../types.ts";
import {
  runSyncThroughputOnce,
  type SyncThroughputRunOptions,
} from "./bench-sync-throughput-shared.ts";

export type { IpcCallFn } from "./bench-sync-throughput-shared.ts";
export type SyncThroughputDriveRunOptions = SyncThroughputRunOptions;

export function runSyncThroughputDriveOnce(
  opts: BenchRunOptions,
  runOpts: SyncThroughputDriveRunOptions = {},
): Promise<number[]> {
  return runSyncThroughputOnce(
    { service: "drive", tmpDirPrefix: "nimbus-bench-drive-", handlers: driveHandlers },
    opts,
    runOpts,
  );
}
