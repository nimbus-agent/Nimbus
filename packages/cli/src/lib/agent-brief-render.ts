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

/** Shared with `expert.ts`, which renders the same gap outside this dispatcher. */
export const EMPTY_INDEX_HINT =
  "No data indexed yet — run `nimbus connector sync <service>` first.\n";
/** In the demo, the index is seeded by `nimbus demo`, not by connecting a service. */
export const DEMO_EMPTY_INDEX_HINT = "The demo index is empty — run nimbus demo to seed it.\n";

/**
 * A backticked `nimbus <cmd>` that does not already target the demo. `nimbus demo …` is left
 * alone: that command selects the demo root on its own, and `nimbus demo stop|reset` is exactly
 * what the tour tells the user to run.
 */
const REAL_INSTALL_COMMAND_RE = /`nimbus (?!--demo\b|demo\b)/g;

/**
 * Rewrites every backticked command a brief names — `` `nimbus connector sync github` `` in a
 * `## Gaps` remediation, say — to `` `nimbus --demo connector sync github` ``, so a user who
 * copies it out of a demo brief reaches the demo gateway, not their real install. The gateway's
 * renderers write these commands (and I31 anchors live there), so the rewrite happens here, at
 * print time, and only on the Markdown: `--json` findings are never touched. A command the demo
 * refuses (`connector sync`) stays refused — it now hits the demo gateway and gets
 * `ERR_DEMO_FORBIDDEN` instead of touching real state.
 *
 * Pure. Only BACKTICKED commands are rewritten; a bare `nimbus foo` in prose is not recognised.
 */
export function demoizeBriefCommands(markdown: string): string {
  return markdown.replace(REAL_INSTALL_COMMAND_RE, "`nimbus --demo ");
}

/**
 * The brief text a CLI command prints: demo-safe commands when `demo`, verbatim otherwise.
 * `demo` must come from the caller's `CliPlatformPaths.demo === true`, never the env var directly.
 */
export function briefTextFor(brief: string, demo: boolean): string {
  return demo ? demoizeBriefCommands(brief) : brief;
}

/**
 * Renders an agent brief to stdout/stderr. Shared across catchup and impact:
 * - `--json` → JSON-stringify findings to stdout
 * - gap category `empty_index` → stderr message + process.exit(1)
 * - else → print brief to stdout (demo-safe commands when `demo`, see `demoizeBriefCommands`)
 *
 * `demo` must come from the caller's `CliPlatformPaths.demo === true`, never the env var directly.
 */
export function renderAgentBrief<T extends { gaps: readonly { category: string }[] }>(
  brief: string,
  findings: T,
  json: boolean,
  demo = false,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
    return;
  }
  if (findings.gaps.some((g) => g.category === "empty_index")) {
    process.stderr.write(demo ? DEMO_EMPTY_INDEX_HINT : EMPTY_INDEX_HINT);
    process.exit(1);
  }
  process.stdout.write(`${briefTextFor(brief, demo)}\n`);
}
