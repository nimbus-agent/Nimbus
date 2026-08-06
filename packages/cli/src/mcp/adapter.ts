import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { AGENT_TOOL_SPECS, failBriefsForClient } from "./agent-tools.ts";
import {
  type ClosableClient,
  type IpcCallable,
  type NotifyingClient,
  supportsClose,
  supportsNotifications,
} from "./client-surface.ts";
import { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";
import {
  type AdapterDeps,
  AGENT_TOOLS_UNSUPPORTED_MESSAGE,
  jsonResult,
  runAgentClassifiedTool,
  runTool,
  type ToolResult,
  type ToolSpec,
} from "./tool-runtime.ts";

export type { ClosableClient, IpcCallable, NotifyingClient } from "./client-surface.ts";
export type { AdapterDeps, ToolResult, ToolSpec } from "./tool-runtime.ts";
// Re-exported so existing importers (and tests) keep reaching these through `adapter.ts`. The
// declarations themselves live in `errors.ts` / `client-surface.ts` / `tool-runtime.ts` to keep
// `agent-tools.ts` free of a runtime import back into this module.
export {
  AGENT_TOOLS_UNSUPPORTED_MESSAGE,
  GATEWAY_DOWN_MESSAGE,
  GatewayUnavailableError,
  isDisconnectError,
};

const MCP_LIMIT_DEFAULT = 20;
const MCP_LIMIT_MAX = 50;
// Whitelisted rawMeta keys, verified against real connector item mappings (e.g. github-sync.ts
// stores a PR's author under `user`, plus `labels`/`merged`/`draft`/`repo`; pagerduty incidents
// use `status`/`severity`/`urgency`). Keep this tight — it is the only rawMeta that reaches the
// editor LLM (see the spec's security checklist).
const META_WHITELIST = [
  "state",
  "status",
  "number",
  "user",
  "author",
  "labels",
  "merged",
  "draft",
  "priority",
  "severity",
  "urgency",
  "environment",
  "conclusion",
  "repo",
] as const;
const META_STRING_MAX = 200;

/** Defense-in-depth: truncate long string values (including inside arrays) so a whitelisted key can't smuggle a large blob. */
function clampMetaValue(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > META_STRING_MAX ? v.slice(0, META_STRING_MAX) : v;
  }
  if (Array.isArray(v)) {
    return v.map(clampMetaValue);
  }
  return v;
}

/** Clamp an MCP-tool limit to [1, 50], defaulting to 20. Independent of the Gateway's own 1–500 clamp. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return MCP_LIMIT_DEFAULT;
  }
  return Math.min(MCP_LIMIT_MAX, Math.max(1, Math.floor(limit)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Pick the whitelisted `rawMeta` fields into a compact object, or undefined if none survive. */
function pickMeta(meta: unknown): Record<string, unknown> | undefined {
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  const m = meta as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const k of META_WHITELIST) {
    const val = m[k];
    if (val !== undefined && val !== null) {
      picked[k] = clampMetaValue(val);
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** Project one ranked index item to a compact, whitelisted shape for an editor LLM. */
export function projectRankedItem(item: unknown): Record<string, unknown> {
  const r = asRecord(item);
  const out: Record<string, unknown> = {};
  if (typeof r["name"] === "string") {
    out["name"] = r["name"];
  }
  if (typeof r["service"] === "string") {
    out["service"] = r["service"];
  }
  // Prefer indexedType (the real type, e.g. "pr"); itemType collapses unknown types to "file".
  const type = typeof r["indexedType"] === "string" ? r["indexedType"] : r["itemType"];
  if (typeof type === "string") {
    out["type"] = type;
  }
  const url = typeof r["url"] === "string" ? r["url"] : r["canonicalUrl"];
  if (typeof url === "string") {
    out["url"] = url;
  }
  if (typeof r["score"] === "number") {
    out["score"] = r["score"];
  }
  if (typeof r["modifiedAt"] === "number") {
    out["modifiedAt"] = r["modifiedAt"];
  }
  if (typeof r["semanticSnippet"] === "string") {
    out["semanticSnippet"] = r["semanticSnippet"];
  }
  const picked = pickMeta(r["rawMeta"]);
  if (picked !== undefined) {
    out["meta"] = picked;
  }
  return out;
}

/** Project a ranked-items array; tolerates a non-array input by returning []. */
export function projectRankedItems(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) {
    return [];
  }
  return rows.map(projectRankedItem);
}

/** Injectable connection primitives so tests avoid real sockets. */
export interface ConnectionEnv {
  readState(): Promise<{ socketPath: string } | undefined>;
  connect(socketPath: string): Promise<IpcCallable>;
}

/**
 * Wrap a raw client so a transport-dead call invalidates the cache, forcing the next getClient to
 * reconnect.
 *
 * The wrapper is what `getClient()` hands out, so it is also what every consumer sees — and the
 * agent tools need `onNotification` to receive `<agent>.briefReady`. A wrapper that forwarded only
 * `call`/`disconnect` would leave `supportsNotifications` false on the ONLY object the tools ever
 * touch, and all ten agent tools would report an incapable transport on a perfectly healthy
 * connection.
 *
 * So EVERY handler-registration method is forwarded, symmetrically and conditionally — a wrapper
 * that silently lacks a capability its raw client has is the whole bug class, and forwarding only
 * the one member that happens to be needed today just relocates it one call site away. Conditional
 * rather than required, so a `ConnectionEnv.connect` implementation with none of them still yields
 * a usable client for the request/response tools.
 */
function makeReconnectingClient(raw: IpcCallable, invalidate: () => void): IpcCallable {
  const wrapper: IpcCallable & Partial<NotifyingClient> & Partial<ClosableClient> = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (isDisconnectError(e)) {
          // `wrapper`, never `raw` — the brief router is keyed on what getClient() returned.
          failBriefsForClient(wrapper, e);
          invalidate();
          void raw.disconnect().catch(() => {});
        }
        throw e;
      }
    },
    disconnect(): Promise<void> {
      return raw.disconnect();
    },
  };
  if (supportsNotifications(raw)) {
    wrapper.onNotification = (method: string, handler: (params: unknown) => void): void => {
      raw.onNotification(method, handler);
    };
    const rawOff = raw.offNotification;
    if (rawOff !== undefined) {
      wrapper.offNotification = (method: string, handler: (params: unknown) => void): void => {
        rawOff.call(raw, method, handler);
      };
    }
  }
  if (supportsClose(raw)) {
    wrapper.onClose = (handler: (err: Error) => void): void => {
      raw.onClose(handler);
    };
    wrapper.offClose = (handler: (err: Error) => void): void => {
      raw.offClose(handler);
    };
  }
  return wrapper;
}

export function createDeps(env: ConnectionEnv): AdapterDeps {
  let cached: IpcCallable | null = null;
  let connecting: Promise<IpcCallable> | null = null;
  // Owner decision: a gateway that rejects `session.declareKind` as an unsupported method serves
  // briefs it cannot attribute, so the agent tools are withdrawn and the six read-only index tools
  // — which were never ledgered and never claimed to be — keep working. Warning on stderr alone was
  // not enough: editor-spawned MCP servers usually discard stderr, so the operator got unrecorded
  // briefs while `nimbus prove` reported a clean scope.
  let agentToolsDisabled = false;
  const invalidate = (): void => {
    cached = null;
  };
  const openConnection = async (): Promise<IpcCallable> => {
    const state = await env.readState();
    if (state === undefined) {
      throw new GatewayUnavailableError();
    }
    let raw: IpcCallable;
    try {
      raw = await env.connect(state.socketPath);
    } catch {
      throw new GatewayUnavailableError();
    }
    const client = makeReconnectingClient(raw, invalidate);
    // The `call`-failure hook above only fires when a call fails, and while awaiting a brief there
    // is no call in flight — a solitary in-flight brief would otherwise sit out the full agent
    // timeout after the gateway dies. `onClose` fires on an UNEXPECTED transport close only (never
    // on an ordinary `disconnect()`), at most once per connection, which is what makes it safe to
    // leave bound with no teardown path.
    //
    // The router is keyed on `client` (the wrapper) because that is what getClient() returns, while
    // onClose lives on `raw`. Passing `raw` here would look up a key that was never inserted, miss
    // silently, and leave every waiter to time out.
    if (supportsClose(raw)) {
      raw.onClose((err: Error) => {
        failBriefsForClient(client, err);
        invalidate();
      });
    }
    // I29: identify this connection as MCP so the gateway records briefs served over it as egress.
    // Best-effort — an older gateway without `session.declareKind` must not break the adapter.
    try {
      await client.call("session.declareKind", { kind: "mcp" });
      agentToolsDisabled = false;
    } catch (e) {
      if (isDisconnectError(e)) {
        // `client.call`'s own catch (inside `makeReconnectingClient`) already invalidated the
        // cache and disconnected `raw` — this is a dead connection, not an old gateway. Printing
        // the "upgrade the gateway" warning here would misdiagnose a transport drop as a missing
        // RPC method, and re-caching `client` below would hand out a connection already known
        // dead. Return it uncached instead: the caller's next real call on it fails with the same
        // disconnect error and self-heals via `invalidate()` on the `getClient()` after that — the
        // same path an ordinary mid-call disconnect already takes.
        return client;
      }
      // Older gateway: it would still serve briefs, but it cannot attribute them, so nothing would
      // reach the egress ledger. The agent tools are therefore withheld — see `agentToolsDisabled`
      // above. The stderr warning is kept (it is the only place the full reason fits) but is no
      // longer the sole signal, because an editor-spawned server's stderr usually goes nowhere.
      // stderr is safe here: the MCP protocol channel is stdout.
      agentToolsDisabled = true;
      process.stderr.write(
        "nimbus-mcp: gateway does not support session.declareKind; agent briefs served over MCP would NOT appear in the egress ledger, so the agent tools are DISABLED on this connection. The read-only index tools still work. Upgrade the gateway.\n",
      );
    }
    cached = client;
    return client;
  };
  return {
    async getClient(): Promise<IpcCallable> {
      if (cached !== null) {
        return cached;
      }
      connecting ??= openConnection().finally(() => {
        connecting = null;
      });
      return connecting;
    },
    agentToolsDisabledReason(): string | undefined {
      return agentToolsDisabled ? AGENT_TOOLS_UNSUPPORTED_MESSAGE : undefined;
    },
  };
}

/** Production deps: real gateway-state read + real IPCClient connect. */
export function createProductionDeps(): AdapterDeps {
  return createDeps({
    readState: async () => {
      const s = await readGatewayState(getCliPlatformPaths());
      return s === undefined ? undefined : { socketPath: s.socketPath };
    },
    connect: async (socketPath: string) => {
      const client = new IPCClient(socketPath);
      await client.connect();
      return client;
    },
  });
}

function optString(o: Record<string, unknown>, k: string): string | undefined {
  const v = o[k];
  return typeof v === "string" ? v : undefined;
}

function optNumber(o: Record<string, unknown>, k: string): number | undefined {
  const v = o[k];
  return typeof v === "number" ? v : undefined;
}

function optBool(o: Record<string, unknown>, k: string): boolean | undefined {
  const v = o[k];
  return typeof v === "boolean" ? v : undefined;
}

/** Build index.searchRanked params, omitting undefined optionals so they don't appear in the request. */
function searchParams(opts: {
  name: string;
  itemType: string | undefined;
  service: string | undefined;
  limit: number;
  semantic: boolean;
}): Record<string, unknown> {
  const p: Record<string, unknown> = {
    name: opts.name,
    limit: opts.limit,
    semantic: opts.semantic,
    contextChunks: 0,
  };
  if (opts.itemType !== undefined) {
    p["itemType"] = opts.itemType;
  }
  if (opts.service !== undefined) {
    p["service"] = opts.service;
  }
  return p;
}

async function searchAndProject(
  client: IpcCallable,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rows = await client.call<unknown>("index.searchRanked", params);
  return jsonResult(projectRankedItems(rows));
}

/** A browse tool pinned to one itemType (recent items, recency-ranked). */
function browseTool(itemType: string) {
  return (deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult> =>
    runTool(deps, (c) =>
      searchAndProject(
        c,
        searchParams({
          name: "",
          itemType,
          service: optString(args, "service"),
          limit: clampLimit(optNumber(args, "limit")),
          semantic: false,
        }),
      ),
    );
}

const limitArg = z.number().int().positive().optional();
const serviceArg = z.string().optional();

/**
 * The read-only index tools. These read the local index directly and hand the caller projected
 * rows; they have never appended an egress row and have never claimed to, so they stay available on
 * a gateway too old to attribute MCP-served output (see `AGENT_TOOLS_UNSUPPORTED_MESSAGE`).
 */
export const INDEX_TOOL_SPECS: ToolSpec[] = [
  {
    name: "searchIndex",
    description:
      "Search the Nimbus local index across all connected services (Drive, GitHub, Slack, Jira, etc.). Returns ranked items. Optionally filter by service or itemType.",
    schema: {
      query: z.string(),
      service: serviceArg,
      itemType: z.string().optional(),
      limit: limitArg,
      semantic: z.boolean().optional(),
    },
    run: (deps, args) =>
      runTool(deps, (c) =>
        searchAndProject(
          c,
          searchParams({
            name: optString(args, "query") ?? "",
            itemType: optString(args, "itemType"),
            service: optString(args, "service"),
            limit: clampLimit(optNumber(args, "limit")),
            semantic: optBool(args, "semantic") !== false,
          }),
        ),
      ),
  },
  {
    name: "getConnectorStatus",
    description: "List Nimbus connector health and sync state for every configured connector.",
    schema: {},
    run: (deps) => runTool(deps, async (c) => jsonResult(await c.call("connector.listStatus"))),
  },
  {
    name: "getRecentIncidents",
    description:
      "List recent incidents from the local index (most recent first). Optionally filter by service.",
    schema: { limit: limitArg, service: serviceArg },
    run: browseTool("incident"),
  },
  {
    name: "getRecentPullRequests",
    description:
      "List recent pull requests from the local index (most recent first). Each item carries its state (open/closed/merged) under meta.state when the connector recorded it — filter on that; the index cannot pre-filter by PR state.",
    schema: { limit: limitArg, service: serviceArg },
    run: browseTool("pr"),
  },
  {
    name: "getRecentDeployments",
    description:
      "List recent deployments from the local index (most recent first). Optionally filter by service.",
    schema: { limit: limitArg, service: serviceArg },
    run: browseTool("deployment"),
  },
  {
    name: "getDoraMetrics",
    description:
      "Get DORA metrics (deployment frequency, lead time for changes, change failure rate, MTTR) for a configured service. `since` accepts values like '30d'.",
    schema: { service: z.string(), since: z.string().optional() },
    run: (deps, args) =>
      runTool(deps, async (c) => {
        // `service` is a required zod field, so the SDK guarantees a string before `run` is
        // reached. The `?? ""` is kept only because `run` is exported and called directly in
        // unit tests (which bypass zod); an empty string is then safely rejected by the
        // Gateway's metrics.dora handler ("service must be a string"/length check), not crashed on.
        const params: Record<string, unknown> = { service: optString(args, "service") ?? "" };
        const since = optString(args, "since");
        if (since !== undefined) {
          params["since"] = since;
        }
        return jsonResult(await c.call("metrics.dora", params));
      }),
  },
];

/**
 * The agent-classified tools: everything that serves gateway-SYNTHESISED output to the caller's
 * model, and therefore everything whose use must land in the egress ledger.
 *
 * `peekWhy` belongs here even though it is synchronous and reads no notification — it is
 * `agents.whyPeek`, it is ledgered by the same gateway-side chokepoint, and classifying it with the
 * index tools because of its call shape is exactly the mistake this list exists to prevent.
 *
 * Every entry runs through `runAgentClassifiedTool`, so reaching one on a gateway that cannot
 * attribute it yields an actionable error rather than an unrecorded brief.
 */
export const AGENT_CLASSIFIED_TOOL_SPECS: ToolSpec[] = [
  {
    name: "peekWhy",
    description:
      "Fast why-lens probe: returns a one-line explanation of why code is the way it is (author, commit, date, subject, PR, ticket), drawn from the local relationship graph. `ref` is a repo-relative `path[:line]` or a bare symbol name. Synchronous — use explainWhy for the full brief.",
    schema: { ref: z.string() },
    run: (deps, args) =>
      runAgentClassifiedTool(deps, async (c) =>
        jsonResult(await c.call("agents.whyPeek", { ref: optString(args, "ref") ?? "" })),
      ),
  },
  ...AGENT_TOOL_SPECS,
];

export const TOOL_SPECS: ToolSpec[] = [...INDEX_TOOL_SPECS, ...AGENT_CLASSIFIED_TOOL_SPECS];

/**
 * Whether this gateway can attribute MCP-served agent briefs, and so whether the agent tools may be
 * registered at all.
 *
 * A gateway that is merely NOT RUNNING is deliberately treated as capable: it is not an old
 * gateway, the tools are registered, and reaching one reports "Gateway is not running" through the
 * ordinary path. Withdrawing the tools because the gateway happened to be down when the editor
 * spawned this process would be a far worse failure than the one being fixed.
 */
export async function agentToolsSupported(deps: AdapterDeps): Promise<boolean> {
  try {
    await deps.getClient();
  } catch {
    return true;
  }
  return deps.agentToolsDisabledReason?.() === undefined;
}

/**
 * Build the MCP server.
 *
 * `includeAgentTools: false` registers ONLY the six read-only index tools — the fail-closed shape
 * for a gateway that rejects `session.declareKind`. Serving unrecorded briefs while `nimbus prove`
 * reports a clean scope is the exact failure this feature exists to close, so the honest answer is
 * to withhold the surface, not to warn about it on a stream the editor discards.
 */
export function buildMcpServer(deps: AdapterDeps, includeAgentTools = true): McpServer {
  const server = new McpServer({ name: "nimbus", version: "0.1.0" });
  for (const s of includeAgentTools ? TOOL_SPECS : INDEX_TOOL_SPECS) {
    server.registerTool(
      s.name,
      { description: s.description, inputSchema: s.schema },
      (args: unknown) => s.run(deps, asRecord(args)),
    );
  }
  return server;
}

/** Run the MCP server over stdio (this process is launched by the editor). */
export async function runMcpServerStdio(deps: AdapterDeps): Promise<void> {
  const server = buildMcpServer(deps, await agentToolsSupported(deps));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
