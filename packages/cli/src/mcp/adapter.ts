import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

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

export const GATEWAY_DOWN_MESSAGE = "Nimbus Gateway is not running. Start it with: nimbus start";

/** Thrown when the adapter cannot reach the Gateway (no state file, or connect failed). */
export class GatewayUnavailableError extends Error {
  constructor() {
    super(GATEWAY_DOWN_MESSAGE);
    this.name = "GatewayUnavailableError";
  }
}

/** Minimal IPC surface the adapter needs — structurally satisfied by IPCClient. */
export interface IpcCallable {
  call<T>(method: string, params?: unknown): Promise<T>;
  disconnect(): Promise<void>;
}

export interface AdapterDeps {
  /** Returns a connected client, reusing a cached connection while it is healthy. */
  getClient(): Promise<IpcCallable>;
}

/** Injectable connection primitives so tests avoid real sockets. */
export interface ConnectionEnv {
  readState(): Promise<{ socketPath: string } | undefined>;
  connect(socketPath: string): Promise<IpcCallable>;
}

const DISCONNECT_MESSAGES: ReadonlySet<string> = new Set([
  "IPC client is not connected",
  "IPC connection closed",
  "IPC connection error",
]);

/** True when an error is one of IPCClient's transport-dead messages and a reconnect is warranted. */
export function isDisconnectError(e: unknown): boolean {
  return e instanceof Error && DISCONNECT_MESSAGES.has(e.message);
}

/** Wrap a raw client so a transport-dead call invalidates the cache, forcing the next getClient to reconnect. */
function makeReconnectingClient(raw: IpcCallable, invalidate: () => void): IpcCallable {
  return {
    async call<T>(method: string, params?: unknown): Promise<T> {
      try {
        return await raw.call<T>(method, params);
      } catch (e) {
        if (isDisconnectError(e)) {
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
}

export function createDeps(env: ConnectionEnv): AdapterDeps {
  let cached: IpcCallable | null = null;
  let connecting: Promise<IpcCallable> | null = null;
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
    // I29: identify this connection as MCP so the gateway records briefs served over it as egress.
    // Best-effort — an older gateway without `session.declareKind` must not break the adapter.
    try {
      await client.call("session.declareKind", { kind: "mcp" });
    } catch {
      // Older gateway: it will still serve briefs, but it cannot attribute them, so nothing is
      // recorded in the egress ledger. Say so on stderr — silently serving unrecorded briefs would
      // make `nimbus prove` quietly wrong, which is the exact failure this feature exists to close.
      // stderr is safe here: the MCP protocol channel is stdout.
      process.stderr.write(
        "nimbus-mcp: gateway does not support session.declareKind; agent briefs served over MCP will NOT appear in the egress ledger. Upgrade the gateway.\n",
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

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
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

/** Obtain a client and run `fn`, converting all failures into MCP error results (never a throw). */
async function runTool(
  deps: AdapterDeps,
  fn: (c: IpcCallable) => Promise<ToolResult>,
): Promise<ToolResult> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      return errorResult(e.message);
    }
    return errorResult(`Nimbus: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await fn(client);
  } catch (e) {
    if (isDisconnectError(e)) {
      return errorResult(GATEWAY_DOWN_MESSAGE);
    }
    return errorResult(`Nimbus: ${e instanceof Error ? e.message : String(e)}`);
  }
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

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  run(deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult>;
}

const limitArg = z.number().int().positive().optional();
const serviceArg = z.string().optional();

export const TOOL_SPECS: ToolSpec[] = [
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
  {
    name: "peekWhy",
    description:
      "Fast why-lens probe for a file or PR URL: returns a compact explanation of why the code is the way it is, drawn from the local relationship graph (authorship, PRs, incidents, decisions). Synchronous — use explainWhy for the full brief.",
    schema: { fileOrPrUrl: z.string() },
    run: (deps, args) =>
      runTool(deps, async (c) =>
        jsonResult(
          await c.call("agents.whyPeek", { fileOrPrUrl: optString(args, "fileOrPrUrl") ?? "" }),
        ),
      ),
  },
];

/** Build the MCP server with all seven read-only tools registered. */
export function buildMcpServer(deps: AdapterDeps): McpServer {
  const server = new McpServer({ name: "nimbus", version: "0.1.0" });
  for (const s of TOOL_SPECS) {
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
  const server = buildMcpServer(deps);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
