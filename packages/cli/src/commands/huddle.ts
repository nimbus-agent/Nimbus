import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type HuddleBrief, isHuddleBrief } from "../types/agents.ts";

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
      const v = Number(args[i + 1]);
      if (!Number.isInteger(v) || v < 0) {
        throw new Error("--since must be a non-negative integer (ms)");
      }
      sinceMs = v;
      i += 1;
    } else if (a === "--namespace") {
      const v = args[i + 1];
      if (typeof v !== "string" || v.trim().length === 0) {
        throw new Error("--namespace requires a value");
      }
      namespaces.push(v.trim());
      i += 1;
    }
  }
  return { sinceMs, json, namespaces };
}

const TIMEOUT_MS = 30_000;

function awaitHuddleBrief(
  client: IPCClient,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: HuddleBrief }> {
  return new Promise<{ brief: string; findings: HuddleBrief }>((resolve, reject) => {
    onTimer(setTimeout(() => reject(new Error("Agent timed out after 30 s")), TIMEOUT_MS));
    client.onNotification("huddle.briefReady", (params: unknown) => {
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !isHuddleBrief(p.findings)) {
        reject(new Error("Malformed huddle.briefReady payload"));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification("huddle.briefError", (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

export async function runHuddleCli(args: string[]): Promise<void> {
  const parsed = parseHuddleArgs(args);

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
  const briefPromise = awaitHuddleBrief(client, (t) => {
    timeout = t;
  });

  const callParams: { sinceMs?: number; namespaces: string[] } = {
    namespaces: parsed.namespaces,
    ...(parsed.sinceMs !== undefined ? { sinceMs: parsed.sinceMs } : {}),
  };

  try {
    await client.call<{ sessionId: string }>("agents.huddle", callParams);
    const { brief, findings } = await briefPromise;
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      process.stdout.write(`${brief}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
