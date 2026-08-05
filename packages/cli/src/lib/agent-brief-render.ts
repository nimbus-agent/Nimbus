import {
  AgentBriefRouter,
  type BriefNotificationSource,
  type PendingBrief,
} from "./agent-brief-router.ts";

// Re-exported so callers (agent-cli-dispatcher.ts) can import the return type of
// `awaitAgentBrief` from this module instead of reaching into the router directly.
export type { PendingBrief };

const TIMEOUT_MS = 30_000;

/** One router per client, so listeners are registered once per agent name per connection. */
const routers = new WeakMap<object, AgentBriefRouter>();

function routerFor(client: BriefNotificationSource): AgentBriefRouter {
  const existing = routers.get(client as object);
  if (existing !== undefined) return existing;
  const created = new AgentBriefRouter(client);
  routers.set(client as object, created);
  return created;
}

/**
 * Start awaiting an agent brief. The caller MUST call `bindSession` with the sessionId returned
 * by the `agents.*` call — notifications are broadcast to every session, so without it a
 * concurrent caller's brief can be mistaken for this one.
 */
export function awaitAgentBrief<T>(
  client: BriefNotificationSource,
  agentName: string,
  guard: (x: unknown) => x is T,
  timeoutMs: number = TIMEOUT_MS,
): PendingBrief<T> {
  return routerFor(client).expect(agentName, guard, timeoutMs);
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
