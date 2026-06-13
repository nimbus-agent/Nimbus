import { type ConflictBrief, isConflictBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";
import { parseFileNamespacesArgs } from "./_parse-file-namespaces-args.ts";

export type ConflictsCliArgs = { file: string; json: boolean; namespaces: string[] };

export function parseConflictsArgs(args: string[]): ConflictsCliArgs {
  return parseFileNamespacesArgs(args, "conflicts");
}

export async function runConflictsCli(args: string[]): Promise<void> {
  const parsed = parseConflictsArgs(args);
  await runAgentBriefCli<ConflictBrief>({
    kind: "conflicts",
    guard: isConflictBrief,
    json: parsed.json,
    params: { file: parsed.file, namespaces: parsed.namespaces },
  });
}
