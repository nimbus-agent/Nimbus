import { isJanitorBrief, type JanitorBrief } from "../types/agents.ts";
import { flagValue, runAgentBriefCli } from "./_agent-brief-cli.ts";

export type JanitorCliArgs = {
  resourceRef: string;
  idleDays: number;
  cleanupAction: string | null;
  allowGaps: boolean;
  json: boolean;
};

export function parseJanitorArgs(args: string[]): JanitorCliArgs {
  const positional: string[] = [];
  let idleDays = 14;
  let cleanupAction: string | null = null;
  let allowGaps = false;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--allow-gaps") allowGaps = true;
    else if (a === "--idle-days") {
      const n = Number(flagValue(args, i, "--idle-days"));
      if (!Number.isInteger(n) || n <= 0) throw new Error("--idle-days must be a positive integer");
      idleDays = n;
      i += 1;
    } else if (a === "--cleanup") {
      cleanupAction = flagValue(args, i, "--cleanup");
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const resourceRef = positional.join(" ").trim();
  if (resourceRef.length === 0) {
    throw new Error(
      "Usage: nimbus janitor <resource-ref> [--idle-days N] [--cleanup <action.type>] [--allow-gaps] [--json]",
    );
  }
  return { resourceRef, idleDays, cleanupAction, allowGaps, json };
}

export async function runJanitorCli(args: string[]): Promise<void> {
  const parsed = parseJanitorArgs(args);
  await runAgentBriefCli<JanitorBrief>({
    kind: "janitor",
    guard: isJanitorBrief,
    json: parsed.json,
    params: {
      resourceRef: parsed.resourceRef,
      idleDays: parsed.idleDays,
      allowGaps: parsed.allowGaps,
      ...(parsed.cleanupAction === null ? {} : { cleanupAction: parsed.cleanupAction }),
    },
  });
}
