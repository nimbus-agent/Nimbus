import { type HuddleBrief, isHuddleBrief } from "../types/agents.ts";
import { runAgentBriefCli } from "./_agent-brief-cli.ts";

export type HuddleCliArgs = { sinceMs: number | undefined; json: boolean; namespaces: string[] };

export function parseHuddleArgs(args: string[]): HuddleCliArgs {
  let sinceMs: number | undefined;
  let json = false;
  const namespaces: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      const raw = args[i + 1];
      const v = Number(raw);
      if (raw === undefined || raw.startsWith("--") || !Number.isInteger(v) || v < 0) {
        throw new Error("--since must be a non-negative integer (ms)");
      }
      sinceMs = v;
      i += 1;
    } else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) {
        throw new Error("--namespace requires a value");
      }
      namespaces.push(v.trim());
      i += 1;
    }
  }
  return { sinceMs, json, namespaces };
}

export async function runHuddleCli(args: string[]): Promise<void> {
  const parsed = parseHuddleArgs(args);
  const params: { sinceMs?: number; namespaces: string[] } = {
    namespaces: parsed.namespaces,
    ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
  };
  await runAgentBriefCli<HuddleBrief>({
    kind: "huddle",
    guard: isHuddleBrief,
    json: parsed.json,
    params,
  });
}
