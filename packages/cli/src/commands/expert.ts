import { IPCClient } from "../ipc-client/index.ts";
import { resolveBriefTimeoutMs } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type ExpertBrief, isExpertBrief } from "../types/agents.ts";

export type ExpertCliArgs = {
  topicOrFile: string;
  json: boolean;
  limit?: number;
};

export function parseExpertArgs(args: string[]): ExpertCliArgs {
  const positional: string[] = [];
  let json = false;
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--limit") {
      const n = Number(args[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 25) {
        throw new Error("--limit must be an integer in 1..25");
      }
      limit = n;
      i += 1;
      continue;
    }
    if (a !== undefined && !a.startsWith("--")) positional.push(a);
  }
  const topicOrFile = positional.join(" ").trim();
  if (topicOrFile.length === 0) {
    throw new Error('Usage: nimbus expert "<topic-or-file>" [--json] [--limit <N>]');
  }
  const out: ExpertCliArgs = { topicOrFile, json };
  if (limit !== undefined) out.limit = limit;
  return out;
}

export async function runExpertCli(args: string[]): Promise<void> {
  const parsed = parseExpertArgs(args);

  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  await client.connect();
  registerInteractiveCliIpcHandlers(client);

  let timeout: ReturnType<typeof setTimeout> | undefined;

  const briefPromise = new Promise<{ brief: string; findings: ExpertBrief }>((resolve, reject) => {
    const timeoutMs = resolveBriefTimeoutMs();
    timeout = setTimeout(
      () => reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    client.onNotification("expert.briefReady", (params: unknown) => {
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !isExpertBrief(p.findings)) {
        reject(new Error("Malformed expert.briefReady payload"));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification("expert.briefError", (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });

  const callParams: { topicOrFile: string; limit?: number } = { topicOrFile: parsed.topicOrFile };
  if (parsed.limit !== undefined) callParams.limit = parsed.limit;

  try {
    await client.call<{ sessionId: string }>("agents.expert", callParams);
    const { brief, findings } = await briefPromise;
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
      return;
    }
    if (findings.gaps.some((g) => g.category === "empty_index")) {
      process.stderr.write("No data indexed yet — run `nimbus connector sync <service>` first.\n");
      process.exit(1);
    }
    process.stdout.write(`${brief}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
