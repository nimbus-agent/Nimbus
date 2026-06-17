import { IPCClient } from "../ipc-client/index.ts";
import { awaitAgentBrief, renderAgentBrief } from "../lib/agent-brief-render.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { isImpactBrief } from "../types/agents.ts";

export type ImpactCliArgs = {
  fileOrPrUrl: string;
  json: boolean;
  depth?: number;
  service?: string;
};

function parseDepthFlag(raw: string | undefined): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error("--depth must be an integer in 1..5");
  }
  return n;
}

function parseServiceFlag(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("--service requires a non-empty value");
  }
  return raw.trim();
}

export function parseImpactArgs(args: string[]): ImpactCliArgs {
  const positional: string[] = [];
  let json = false;
  let depth: number | undefined;
  let service: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--depth") {
      depth = parseDepthFlag(args[i + 1]);
      i += 1;
    } else if (a === "--service") {
      service = parseServiceFlag(args[i + 1]);
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) {
      positional.push(a);
    }
  }
  const fileOrPrUrl = positional.join(" ").trim();
  if (fileOrPrUrl.length === 0) {
    throw new Error(
      'Usage: nimbus impact "<file-or-PR-url>" [--json] [--depth <N>] [--service <id>]',
    );
  }
  const out: ImpactCliArgs = { fileOrPrUrl, json };
  if (depth !== undefined) out.depth = depth;
  if (service !== undefined) out.service = service;
  return out;
}

export async function runImpactCli(args: string[]): Promise<void> {
  const parsed = parseImpactArgs(args);

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
  const briefPromise = awaitAgentBrief(client, "impact", isImpactBrief, (t) => {
    timeout = t;
  });

  const callParams: { fileOrPrUrl: string; depth?: number; service?: string } = {
    fileOrPrUrl: parsed.fileOrPrUrl,
  };
  if (parsed.depth !== undefined) callParams.depth = parsed.depth;
  if (parsed.service !== undefined) callParams.service = parsed.service;

  try {
    await client.call<{ sessionId: string }>("agents.impact", callParams);
    const { brief, findings } = await briefPromise;
    renderAgentBrief(brief, findings, parsed.json);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
