import { unlink } from "node:fs/promises";

import { spinner } from "@clack/prompts";

import { gatewayStatePath, readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type StopDecision =
  | { action: "no-state"; reason: "no gateway state recorded" }
  | { action: "signal"; pid: number };

export function decideStopAction(state: { pid: number } | undefined): StopDecision {
  if (state === undefined) {
    return { action: "no-state", reason: "no gateway state recorded" };
  }
  return { action: "signal", pid: state.pid };
}

export async function runStop(_args: string[]): Promise<void> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  const decision = decideStopAction(state);
  if (decision.action === "no-state") {
    console.log("No gateway state found (is it running?).");
    return;
  }

  const s = spinner();
  s.start("Stopping Gateway");

  try {
    process.kill(decision.pid, "SIGTERM");
  } catch {
    /* process may already be gone */
  }

  try {
    await unlink(gatewayStatePath(paths));
  } catch {
    /* ignore */
  }

  s.stop("Stop signal sent");
}
