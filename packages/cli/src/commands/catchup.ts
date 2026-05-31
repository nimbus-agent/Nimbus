import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { parseSinceDurationToMs } from "../lib/parse-since.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { type CatchupBrief, isCatchupBrief } from "../types/agents.ts";

const DEFAULT_SINCE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 30_000;

export type CatchupCliArgs = {
  sinceMs: number;
  json: boolean;
  service?: string;
};

function parseSinceFlag(raw: string | undefined): number {
  if (typeof raw !== "string") throw new Error("--since requires a value (e.g. 3d, 12h, 1w)");
  const sinceMs = parseSinceDurationToMs(raw);
  if (sinceMs > MAX_SINCE_MS) {
    throw new Error("--since must be at most 90 days (e.g. 90d, 12w)");
  }
  return sinceMs;
}

function parseServiceFlag(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("--service requires a non-empty value");
  }
  return raw.trim();
}

export function parseCatchupArgs(args: string[]): CatchupCliArgs {
  let sinceMs = DEFAULT_SINCE_MS;
  let json = false;
  let service: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      json = true;
    } else if (a === "--since") {
      sinceMs = parseSinceFlag(args[i + 1]);
      i += 1;
    } else if (a === "--service") {
      service = parseServiceFlag(args[i + 1]);
      i += 1;
    } else if (a !== undefined && !a.startsWith("--")) {
      throw new Error(
        `Unknown positional argument: ${a}. Usage: nimbus catchup [--since 3d] [--json] [--service <id>]`,
      );
    }
  }
  const out: CatchupCliArgs = { sinceMs, json };
  if (service !== undefined) out.service = service;
  return out;
}

function awaitCatchupBrief(
  client: IPCClient,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: CatchupBrief }> {
  return new Promise<{ brief: string; findings: CatchupBrief }>((resolve, reject) => {
    onTimer(setTimeout(() => reject(new Error("Agent timed out after 30 s")), TIMEOUT_MS));
    client.onNotification("catchup.briefReady", (params: unknown) => {
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !isCatchupBrief(p.findings)) {
        reject(new Error("Malformed catchup.briefReady payload"));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification("catchup.briefError", (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

function renderCatchupBrief(brief: string, findings: CatchupBrief, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return;
  }
  if (findings.gaps.some((g) => g.category === "empty_index")) {
    process.stderr.write("No data indexed yet — run `nimbus connector sync <service>` first.\n");
    process.exit(1);
  }
  process.stdout.write(`${brief}\n`);
}

export async function runCatchupCli(args: string[]): Promise<void> {
  const parsed = parseCatchupArgs(args);

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
  const briefPromise = awaitCatchupBrief(client, (t) => {
    timeout = t;
  });

  const callParams: { sinceMs: number; service?: string } = { sinceMs: parsed.sinceMs };
  if (parsed.service !== undefined) callParams.service = parsed.service;

  try {
    await client.call<{ sessionId: string }>("agents.catchup", callParams);
    const { brief, findings } = await briefPromise;
    renderCatchupBrief(brief, findings, parsed.json);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await client.disconnect();
  }
}
