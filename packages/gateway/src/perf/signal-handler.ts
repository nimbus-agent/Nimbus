import { appendHistoryLine, type HistoryLine } from "./history-line.ts";
import type { RunnerKind } from "./types.ts";

export interface IncompleteContext {
  runId: string;
  runner: RunnerKind;
  reason: string;
  nimbusGitSha: string;
  bunVersion: string;
  osVersion: string;
}

export function writeIncompleteLine(historyPath: string, ctx: IncompleteContext): void {
  const line: HistoryLine = {
    schema_version: 2,
    run_id: ctx.runId,
    timestamp: new Date().toISOString(),
    runner: ctx.runner,
    os_version: ctx.osVersion,
    nimbus_git_sha: ctx.nimbusGitSha,
    bun_version: ctx.bunVersion,
    surfaces: {},
    incomplete: true,
    incomplete_reason: ctx.reason,
  };
  appendHistoryLine(historyPath, line);
}

export function installIncompleteSignalHandler(
  historyPath: string,
  ctxFactory: () => IncompleteContext,
): () => void {
  const handler = (signal: NodeJS.Signals): void => {
    try {
      const ctx = ctxFactory();
      writeIncompleteLine(historyPath, { ...ctx, reason: `interrupted-by-${signal}` });
    } finally {
      process.exit(130);
    }
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
