import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type GhostBrief, isGhostBrief } from "../types/agents.ts";

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

const TIMEOUT_MS = 30_000;

function awaitGhostBrief(
  client: IPCClient,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: GhostBrief }> {
  return new Promise<{ brief: string; findings: GhostBrief }>((resolve, reject) => {
    onTimer(setTimeout(() => reject(new Error("Agent timed out after 30 s")), TIMEOUT_MS));
    client.onNotification("ghost.briefReady", (params: unknown) => {
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !isGhostBrief(p.findings)) {
        reject(new Error("Malformed ghost.briefReady payload"));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification("ghost.briefError", (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

export async function runGhostCli(args: string[]): Promise<void> {
  const parsed = parseGhostArgs(args);

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
  const briefPromise = awaitGhostBrief(client, (t) => {
    timeout = t;
  });

  try {
    await client.call<{ sessionId: string }>("agents.ghost", {
      file: parsed.file,
      namespaces: parsed.namespaces,
    });
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
