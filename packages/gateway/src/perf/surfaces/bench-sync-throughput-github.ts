import { githubHandlers } from "../fixtures/msw-handlers.ts";
import type { BenchRunOptions } from "../types.ts";
import {
  runSyncThroughputOnce,
  type SyncThroughputRunOptions,
} from "./bench-sync-throughput-shared.ts";

export type { IpcCallFn } from "./bench-sync-throughput-shared.ts";
export type SyncThroughputGithubRunOptions = SyncThroughputRunOptions;

export function runSyncThroughputGithubOnce(
  opts: BenchRunOptions,
  runOpts: SyncThroughputGithubRunOptions = {},
): Promise<number[]> {
  return runSyncThroughputOnce(
    { service: "github", tmpDirPrefix: "nimbus-bench-github-", handlers: githubHandlers },
    opts,
    runOpts,
  );
}
