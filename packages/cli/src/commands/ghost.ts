import { type GhostBrief, isGhostBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";

export type GhostCliArgs = { file: string; json: boolean; namespaces: string[] };

export function parseGhostArgs(args: string[]): GhostCliArgs {
  const positional: string[] = [];
  let json = false;
  const namespaces: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error("--namespace requires a value");
      }
      namespaces.push(v.trim());
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    }
  }
  const file = positional.join(" ").trim();
  if (file.length === 0) {
    throw new Error('Usage: nimbus ghost "<file>" [--json] [--namespace <n>]');
  }
  return { file, json, namespaces };
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
