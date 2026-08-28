import { envGet } from "../env.ts";
import {
  AgentBriefRouter,
  type BriefNotificationSource,
  type PendingBrief,
} from "./agent-brief-router.ts";

// Re-exported so callers (agent-cli-dispatcher.ts) can import the return type of
// `awaitAgentBrief` from this module instead of reaching into the router directly.
export type { PendingBrief };

/**
 * Default wall-clock a CLI caller waits for an agent brief.
 *
 * This is a CLIENT-side cap and it silently bounds the gateway's own
 * `[agents] synthesis_timeout_ms`: whichever is smaller wins, and the caller
 * only ever sees the client's error. At the previous 30_000 a gateway
 * configured for 90_000 could never deliver, so any local model slow enough to
 * need more than 30s was unusable for briefs through the CLI — a 14B-class
 * model renders `catchup` in ~41s. Raised so the local-first default path works
 * out of the box; lower it via NIMBUS_BRIEF_TIMEOUT_MS if you would rather fail
 * fast than wait.
 */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Resolve the brief timeout, honouring NIMBUS_BRIEF_TIMEOUT_MS.
 *
 * Read per call, never cached: tests and callers set the variable after this
 * module is imported. A non-positive or unparseable value falls back to the
 * default rather than throwing — a malformed override should not make every
 * brief unrunnable.
 */
export function resolveBriefTimeoutMs(): number {
  const raw = envGet("NIMBUS_BRIEF_TIMEOUT_MS");
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  // Number(), not parseInt(): parseInt stops at the first non-digit, so "40ms"
  // becomes 40 and "1.5" becomes 1 — a 1ms timeout that fails every brief
  // instantly, which is strictly worse than ignoring the override.
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return n;
}

/** One router per client, so listeners are registered once per agent name per connection. */
const routers = new WeakMap<object, AgentBriefRouter>();

function routerFor(client: BriefNotificationSource): AgentBriefRouter {
  // No cast: an interface with a method member is assignable to `object`.
  const existing = routers.get(client);
  if (existing !== undefined) return existing;
  const created = new AgentBriefRouter(client);
  routers.set(client, created);
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
  timeoutMs: number = resolveBriefTimeoutMs(),
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
