import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { registerInteractiveCliIpcHandlers } from "../lib/interactive-ipc-handlers.ts";
import { getCliPlatformPaths } from "../paths.ts";

const TIMEOUT_MS = 30_000;

/** Reads the value following a `--flag`, rejecting empty / another-flag values. Shared by agent CLIs. */
export function flagValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (typeof v !== "string" || v.trim().length === 0 || v.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return v.trim();
}

/**
 * Shared driver for the cross-colleague agent CLI commands (ghost / conflicts / huddle).
 * Each command is a thin parse + a single `runAgentBriefCli` call: this helper owns the
 * gateway-state read, the IPC connect, the `<kind>.briefReady`/`<kind>.briefError`
 * notification wait, the json/markdown render, and the exit codes (1 = no gateway,
 * 2 = agent error / malformed payload). Behavior is identical across kinds.
 */
export type AgentBriefCliSpec<TFindings> = {
  /** Agent kind; drives the `agents.<kind>` IPC method + `<kind>.brief*` notifications. */
  kind: string;
  /** Runtime guard validating the `findings` payload of `<kind>.briefReady`. */
  guard: (x: unknown) => x is TFindings;
  /** Whether to print structured JSON findings (`true`) or the Markdown brief (`false`). */
  json: boolean;
  /** Params forwarded verbatim to the `agents.<kind>` IPC call. */
  params: Record<string, unknown>;
  /** Notification wait timeout (ms). Defaults to 30 s; raise for human-gated agents (preflight). */
  timeoutMs?: number;
  /** Invoked with the typed findings before output — lets a command set its own exit code. */
  onResult?: (findings: TFindings) => void;
  /**
   * Runs after connect, BEFORE the brief-notification timer is armed. Used by
   * `glossary --refresh` to drive a pass that can take minutes; arming the 30 s
   * brief timeout first would kill it.
   */
  beforeCall?: (client: IPCClient) => Promise<void>;
};

function awaitBrief<TFindings>(
  client: IPCClient,
  spec: AgentBriefCliSpec<TFindings>,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: TFindings }> {
  const timeoutMs = spec.timeoutMs ?? TIMEOUT_MS;
  return new Promise<{ brief: string; findings: TFindings }>((resolve, reject) => {
    onTimer(
      setTimeout(
        () => reject(new Error(`Agent timed out after ${Math.round(timeoutMs / 1000)} s`)),
        timeoutMs,
      ),
    );
    client.onNotification(`${spec.kind}.briefReady`, (params: unknown) => {
      if (params === null || typeof params !== "object") {
        reject(new Error(`Malformed ${spec.kind}.briefReady payload`));
        return;
      }
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !spec.guard(p.findings)) {
        reject(new Error(`Malformed ${spec.kind}.briefReady payload`));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification(`${spec.kind}.briefError`, (params: unknown) => {
      if (params === null || typeof params !== "object") {
        reject(new Error("Agent failed"));
        return;
      }
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

export async function runAgentBriefCli<TFindings>(
  spec: AgentBriefCliSpec<TFindings>,
): Promise<void> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }

  const client = new IPCClient(state.socketPath);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await client.connect();
    registerInteractiveCliIpcHandlers(client);
    if (spec.beforeCall !== undefined) await spec.beforeCall(client);
    const briefPromise = awaitBrief(client, spec, (t) => {
      timeout = t;
    });
    await client.call<{ sessionId: string }>(`agents.${spec.kind}`, spec.params);
    const { brief, findings } = await briefPromise;
    spec.onResult?.(findings);
    if (spec.json) {
      process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    } else {
      process.stdout.write(`${brief}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    // IPCClient.disconnect() is safe even when connect() was never called (null socket guards).
    await client.disconnect();
  }
}
