import { z } from "zod";
import { AgentBriefRouter } from "../lib/agent-brief-router.ts";
import { type NotifyingClient, supportsNotifications } from "./client-surface.ts";
import {
  type AdapterDeps,
  errorResult,
  runAgentClassifiedTool,
  type ToolResult,
  type ToolSpec,
} from "./tool-runtime.ts";

const DEFAULT_AGENT_TIMEOUT_MS = 60_000;

/**
 * Ceilings the gateway's own validators enforce, mirrored into the zod schemas so the calling
 * model reads the bound off the tool definition instead of discovering it through a -32602.
 * Kept next to each other so a change in `ipc/agents-rpc.ts` has one place to land here.
 */
const MAX_SINCE_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_EXPERT_LIMIT = 25;
const MAX_SERVICE_LEN = 64;

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

function optStr(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function optBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
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
      "Retrospective digest of what happened across connected services while the user was away, personalized to their work. `sinceMs` is a lookback window in milliseconds, capped at 90 days. `service` narrows the digest to one connected service (e.g. 'github', 'slack').",
    // Bounds mirror the gateway's requireCatchupParams: MAX_SINCE_MS, and a non-empty `service` of
    // at most MAX_SERVICE_LEN chars. Over either the call is rejected -32602, and the model can
    // otherwise only learn the ceiling by tripping it.
    schema: {
      sinceMs: z.number().int().nonnegative().max(MAX_SINCE_MS).optional(),
      service: z.string().min(1).max(MAX_SERVICE_LEN).optional(),
    },
    build: (a) =>
      withOptional({}, { sinceMs: optNum(a, "sinceMs"), service: optStr(a, "service") }),
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
      "Recover decision records that were made but never written down, reconstructed from discussions, PRs and issues. There is no topic filter, but the result can be narrowed: `sinceMs` is a lookback window in milliseconds, `service` restricts to one connected service, `minConfidence` (0..1) raises the floor above the configured default, and `explain` adds the per-decision breakdown of what drove its confidence score.",
    // Bounds mirror the gateway's requireDecisionsParams EXACTLY, including where it is laxer than
    // its siblings: `sinceMs` there is any non-negative integer with NO 90-day cap (unlike catchup
    // and huddle), and `service` is any string with NO length or non-empty check (unlike catchup
    // and impact). A zod bound stricter than the validator would silently reject input the gateway
    // accepts, so those asymmetries are mirrored rather than tidied up here.
    schema: {
      sinceMs: z.number().int().nonnegative().optional(),
      minConfidence: z.number().min(0).max(1).optional(),
      service: z.string().optional(),
      explain: z.boolean().optional(),
      limit: z.number().int().positive().optional(),
    },
    build: (a) =>
      withOptional(
        {},
        {
          sinceMs: optNum(a, "sinceMs"),
          minConfidence: optNum(a, "minConfidence"),
          service: optStr(a, "service"),
          explain: optBool(a, "explain"),
          limit: optNum(a, "limit"),
        },
      ),
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
    tool: "findOwners",
    agent: "ownership",
    description:
      "Answer 'who owns this code?' from recency-weighted git blame already in the local index. Pass `path` for a file or directory inside a configured root, or `service` for a [ci.service.<id>] id, or neither for a coverage summary. `path` and `service` are mutually exclusive. This is AUTHORSHIP-derived ownership — who wrote the lines, not who is formally accountable.",
    // `path` is a bare z.string(): the gateway's requireOwnershipParams trims BEFORE checking
    // 1..2048, so a raw-length bound here would reject whitespace-padded input the gateway
    // accepts — the same reason `ref`/`file`/`fileOrPrUrl` carry no length bound elsewhere in
    // this file. `service` does NOT mirror the gateway exactly: this schema's `min(1)` is an
    // UNTRIMMED-length check, so a whitespace-only string like "  " passes it here, while the
    // gateway (`agents-rpc.ts`) rejects that same value via `p.service.trim().length === 0`.
    // That is fail-safe, not a gap — the request still gets rejected, just one hop later — so
    // the schema is left as-is rather than reshaped to pre-trim. Both sides do agree on the
    // untrimmed max (1..MAX_SERVICE_LEN). The mutual exclusion of path/service is enforced
    // gateway-side and stated in the description, since a zod schema cannot express it without
    // a refinement the tool surface does not carry.
    schema: {
      path: z.string().optional(),
      service: z.string().min(1).max(MAX_SERVICE_LEN).optional(),
    },
    build: (a) => withOptional({}, { path: optStr(a, "path"), service: optStr(a, "service") }),
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
  // DELIBERATELY ABSENT: `agents.premortem`. It is the one built-in agent that WRITES (paused
  // watcher rows plus their deliberate-deletion tombstones, and `--repropose` DELETES those
  // tombstones), with no HITL gate on those writes, so it is excluded from BOTH the MCP tool
  // surface and the HTTP agent surface — matching `agents.preflight`, absent here for the same
  // reason. `HTTP_EXCLUDED_AGENT_METHODS` in `ipc/agents-rpc.ts` is the gateway-side half; a
  // gateway test pins the exclusion. Adding it here would let an external model trigger those
  // writes unprompted.
  //
  // DELIBERATELY ABSENT: `agents.negotiate`. Excluded for a DIFFERENT reason than the two above —
  // it writes nothing and its shape fits this surface fine. It is a CONTRIBUTION BRIEF about a
  // person, and `--person <id>` takes any indexed person, so exposing it here would let an
  // external model assemble a compensation-relevant dossier on a colleague without the machine's
  // owner ever asking for one. The CLI and the Tauri renderer are same-machine, owner-initiated
  // surfaces; a model driving this tool server is not. `HTTP_EXCLUDED_AGENT_METHODS` in
  // `ipc/agents-rpc.ts` excludes it from the HTTP agent surface for the same reason, and a
  // gateway test pins that half.
];

export const AGENT_TOOL_SPECS: ToolSpec[] = DEFS.map((d) => ({
  name: d.tool,
  description: d.description,
  schema: d.schema,
  run: (deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult> =>
    runAgentTool(deps, d, args),
}));

/**
 * Runs one agent tool. Never throws; always returns a `ToolResult`.
 *
 * The gateway-down / disconnect / degraded-gateway envelopes all come from
 * `runAgentClassifiedTool` (→ `runTool`), which is the SINGLE construction site for an error
 * result. This function used to rebuild that shape inline four times, leaving `ToolResult`'s error
 * form with two independent constructors and only the adapter's behind `runTool`'s tests.
 */
async function runAgentTool(
  deps: AdapterDeps,
  def: AgentToolDef,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return await runAgentClassifiedTool(deps, async (client) => {
    if (!supportsNotifications(client)) {
      // Cannot happen with the production IPCClient; reachable with a minimal fake. Reported rather
      // than asserted, because the alternative is a waiter that never settles and a 60 s timeout
      // blaming the agent for a transport that was never capable of delivering the brief.
      return errorResult(
        "Nimbus: this connection cannot receive agent notifications, so no brief can be delivered.",
      );
    }
    return await runAgent(client, def.agent, `agents.${def.agent}`, def.build(args));
  });
}
