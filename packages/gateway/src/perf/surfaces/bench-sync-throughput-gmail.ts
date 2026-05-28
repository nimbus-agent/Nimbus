import { gmailHandlers } from "../fixtures/msw-handlers.ts";
import type { BenchRunOptions } from "../types.ts";
import {
  runSyncThroughputOnce,
  type SyncThroughputRunOptions,
} from "./bench-sync-throughput-shared.ts";

export type { IpcCallFn } from "./bench-sync-throughput-shared.ts";
export type SyncThroughputGmailRunOptions = SyncThroughputRunOptions;

export function runSyncThroughputGmailOnce(
  opts: BenchRunOptions,
  runOpts: SyncThroughputGmailRunOptions = {},
): Promise<number[]> {
  return runSyncThroughputOnce(
    { service: "gmail", tmpDirPrefix: "nimbus-bench-gmail-", handlers: gmailHandlers },
    opts,
    runOpts,
  );
}
