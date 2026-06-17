import type { IPCClient } from "../ipc-client/index.ts";

const TIMEOUT_MS = 30_000;

/**
 * Waits for an agent brief notification from the gateway. Parameterizes the
 * notification names (`${agentName}.briefReady` / `${agentName}.briefError`)
 * and the type guard so that catchup, impact, and future agents share one
 * implementation.
 */
export function awaitAgentBrief<T>(
  client: IPCClient,
  agentName: string,
  guard: (x: unknown) => x is T,
  onTimer: (t: ReturnType<typeof setTimeout>) => void,
): Promise<{ brief: string; findings: T }> {
  return new Promise<{ brief: string; findings: T }>((resolve, reject) => {
    onTimer(setTimeout(() => reject(new Error("Agent timed out after 30 s")), TIMEOUT_MS));
    client.onNotification(`${agentName}.briefReady`, (params: unknown) => {
      const p = params as { sessionId?: string; brief?: string; findings?: unknown };
      if (typeof p.brief !== "string" || !guard(p.findings)) {
        reject(new Error(`Malformed ${agentName}.briefReady payload`));
        return;
      }
      resolve({ brief: p.brief, findings: p.findings });
    });
    client.onNotification(`${agentName}.briefError`, (params: unknown) => {
      const p = params as { error?: string };
      reject(new Error(p.error ?? "Agent failed"));
    });
  });
}

/**
 * Renders an agent brief to stdout/stderr. Shared across catchup and impact:
 * - `--json` → JSON-stringify findings to stdout
 * - gap category `empty_index` → stderr message + process.exit(1)
 * - else → print brief to stdout
 */
export function renderAgentBrief<T extends { gaps: readonly { category: string }[] }>(
  brief: string,
  findings: T,
  json: boolean,
): void {
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
