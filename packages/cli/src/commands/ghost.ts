import { type GhostBrief, isGhostBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";
import { parseFileNamespacesArgs } from "./_parse-file-namespaces-args.ts";

export type GhostCliArgs = { file: string; json: boolean; namespaces: string[] };

export function parseGhostArgs(args: string[]): GhostCliArgs {
  return parseFileNamespacesArgs(args, "ghost");
}

export async function runGhostCli(args: string[]): Promise<void> {
  const parsed = parseGhostArgs(args);
  await runAgentBriefCli<GhostBrief>({
    kind: "ghost",
    guard: isGhostBrief,
    json: parsed.json,
    params: { file: parsed.file, namespaces: parsed.namespaces },
  });
}
