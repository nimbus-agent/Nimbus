import { z } from "zod";
import { AgentBriefRouter } from "../lib/agent-brief-router.ts";
import type { AdapterDeps, ToolResult, ToolSpec } from "./adapter.ts";
import { type IpcCallable, type NotifyingClient, supportsNotifications } from "./client-surface.ts";
import { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * Ceilings the gateway's own validators enforce, mirrored into the zod schemas so the calling
 * model reads the bound off the tool definition instead of discovering it through a -32602.
 * Kept next to each other so a change in `ipc/agents-rpc.ts` has one place to land here.
 */
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_EXPERT_LIMIT = 25;

/**
 * How long to wait for a brief. The default is 60 s rather than the CLI's 30 s because the
 * federation-touching agents (`getPeerContext`, `getTeamHuddle`) wait on paired peers, not just the
 * local index.
 *
 * Configurable by environment because MCP clients impose their own transport timeouts and those
 * differ per editor: an operator whose client gives up sooner wants this lower, so the tool returns
 * a clean error rather than having the call severed underneath it.
 *
 * Deliberately NOT a tool argument. A timeout is a transport concern, and the schema rule this
 * design already established is IPC params only — never presentation or transport knobs. Exposing
 * one would invite the calling model to invent values for it.
 */
export function agentTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env["NIMBUS_MCP_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AGENT_TIMEOUT_MS;
}

/** One router per client object, so listeners bind once per agent name per connection. */
const routers = new WeakMap<object, AgentBriefRouter>();

function routerFor(client: NotifyingClient): AgentBriefRouter {
  const existing = routers.get(client);
  if (existing !== undefined) {
    return existing;
  }
  // No cast: NotifyingClient structurally satisfies BriefNotificationSource.
  const created = new AgentBriefRouter(client);
  routers.set(client, created);
  return created;
}

/**
 * Reject every brief in flight on this client. Wired into the adapter's reconnect `invalidate`
 * hook and its `onClose` bridge so a mid-flight transport death fails fast instead of waiting out
 * the timeout.
 */
export function failBriefsForClient(client: object, err: Error): void {
  routers.get(client)?.failAll(err);
}

function briefResult(brief: string, findings: unknown): ToolResult {
  return {
    content: [
      { type: "text", text: brief },
      { type: "text", text: JSON.stringify(findings, null, 2) },
    ],
  };
}

/**
 * Invoke an async agent and await its brief.
 *
 * The waiter is registered BEFORE the call so a fast agent cannot emit before anyone is listening,
 * and bound to the returned sessionId immediately after, so a concurrent caller's brief is never
 * mistaken for this one.
 */
async function runAgent(
  client: NotifyingClient,
  agentName: string,
  ipcMethod: string,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  // No guard: findings are returned verbatim as JSON, so there is nothing to validate against.
  const pending = routerFor(client).expect<unknown>(agentName, undefined, agentTimeoutMs());
  try {
    const { sessionId } = await client.call<{ sessionId: string }>(ipcMethod, params);
    pending.bindSession(sessionId);
    const { brief, findings } = await pending.result;
    return briefResult(brief, findings);
  } catch (e) {
    pending.cancel();
    throw e;
  }
}

interface AgentToolDef {
  readonly tool: string;
  readonly agent: string;
  readonly description: string;
  readonly schema: Record<string, z.ZodTypeAny>;
  readonly build: (args: Record<string, unknown>) => Record<string, unknown>;
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

function optNum(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}

function withOptional(
  base: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

const DEFS: readonly AgentToolDef[] = [
  {
    tool: "explainWhy",
    agent: "why",
    description:
      "Explain why code is the way it is — six parallel lanes over the local relationship graph (authorship, PRs, incidents, decisions, discussions, adjacent code). Returns a markdown brief. `ref` is a repo-relative `path[:line]` or a bare symbol name resolved against indexed code symbols — not a PR URL.",
    schema: { ref: z.string(), line: z.number().int().positive().optional() },
    build: (a) => withOptional({ ref: str(a, "ref") }, { line: optNum(a, "line") }),
  },
  {
    tool: "getCatchup",
    agent: "catchup",
    description:
      "Retrospective digest of what happened across connected services while the user was away, personalized to their work. `sinceMs` is a lookback window in milliseconds, capped at 90 days.",
    // Bound mirrors MAX_SINCE_MS in the gateway's requireCatchupParams: over it the call is
    // rejected -32602, and the model can otherwise only learn the ceiling by tripping it.
    schema: { sinceMs: z.number().int().nonnegative().max(MAX_SINCE_MS).optional() },
    build: (a) => withOptional({}, { sinceMs: optNum(a, "sinceMs") }),
  },
  {
    tool: "findExpert",
    agent: "expert",
    description:
      "Answer 'who has the most context on this?' — a ranked list of people drawn from indexed PRs, reviews, incidents and discussions. `limit` is capped at 25.",
    // Bound mirrors MAX_LIMIT in the gateway's requireExpertParams.
    schema: {
      topicOrFile: z.string(),
      limit: z.number().int().positive().max(MAX_EXPERT_LIMIT).optional(),
    },
    build: (a) =>
      withOptional({ topicOrFile: str(a, "topicOrFile") }, { limit: optNum(a, "limit") }),
  },
  {
    tool: "assessImpact",
    agent: "impact",
    description:
      "Answer 'if I change this, what breaks?' — reverse-dependency blast radius across services, dashboards, tests, docs and owners.",
    schema: { fileOrPrUrl: z.string(), depth: z.number().int().min(1).max(5).optional() },
    build: (a) =>
      withOptional({ fileOrPrUrl: str(a, "fileOrPrUrl") }, { depth: optNum(a, "depth") }),
  },
  {
    tool: "findConflicts",
    agent: "conflicts",
    description:
      "Warn of work-in-progress collisions before editing a file — teammates with an open PR or assigned ticket touching the same code.",
    schema: { file: z.string() },
    build: (a) => ({ file: str(a, "file") }),
  },
  {
    tool: "findDecisions",
    agent: "decisions",
    description:
      "Recover decision records that were made but never written down, reconstructed from discussions, PRs and issues. There is no topic filter — the agent returns the highest-confidence decisions it reconstructed.",
    schema: { limit: z.number().int().positive().optional() },
    build: (a) => withOptional({}, { limit: optNum(a, "limit") }),
  },
  {
    tool: "getGlossary",
    agent: "glossary",
    description:
      "Team terminology as a queryable glossary, extracted from how the team actually writes. Returns one term's definition when `term` is given, otherwise lists the glossary.",
    schema: { term: z.string().optional(), limit: z.number().int().positive().optional() },
    build: (a) => withOptional({}, { term: a["term"], limit: optNum(a, "limit") }),
  },
  {
    tool: "checkResourceUsage",
    agent: "janitor",
    description:
      "Answer 'is this cloud resource still in use, and what breaks if I delete it?' — cross-references a resource against indexed code, config and deploys.",
    schema: { resourceRef: z.string() },
    build: (a) => ({ resourceRef: str(a, "resourceRef") }),
  },
  {
    tool: "getPeerContext",
    agent: "ghost",
    description:
      "Ambient teammate context for a file, gathered from paired peers across the federation mesh. Reaches the network beyond this machine.",
    schema: { file: z.string() },
    build: (a) => ({ file: str(a, "file") }),
  },
  {
    tool: "getTeamHuddle",
    agent: "huddle",
    description:
      "Team-scoped briefing aggregating each teammate's recent PRs, tickets and incidents from paired peers. Reaches the network beyond this machine.",
    schema: { namespace: z.string().optional() },
    build: (a) => withOptional({}, { namespace: a["namespace"] }),
  },
];

export const AGENT_TOOL_SPECS: ToolSpec[] = DEFS.map((d) => ({
  name: d.tool,
  description: d.description,
  schema: d.schema,
  run: (deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult> =>
    runAgentTool(deps, d, args),
}));

/** Mirrors the adapter's `runTool` contract: never throws, always returns a ToolResult. */
async function runAgentTool(
  deps: AdapterDeps,
  def: AgentToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Nimbus: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
  if (!supportsNotifications(client)) {
    // Cannot happen with the production IPCClient; reachable with a minimal fake. Reported rather
    // than asserted, because the alternative is a waiter that never settles and a 60 s timeout
    // blaming the agent for a transport that was never capable of delivering the brief.
    return {
      content: [
        {
          type: "text",
          text: "Nimbus: this connection cannot receive agent notifications, so no brief can be delivered.",
        },
      ],
      isError: true,
    };
  }
  try {
    return await runAgent(client, def.agent, `agents.${def.agent}`, def.build(args));
  } catch (e) {
    if (isDisconnectError(e)) {
      return { content: [{ type: "text", text: GATEWAY_DOWN_MESSAGE }], isError: true };
    }
    return {
      content: [{ type: "text", text: `Nimbus: ${e instanceof Error ? e.message : String(e)}` }],
      isError: true,
    };
  }
}
