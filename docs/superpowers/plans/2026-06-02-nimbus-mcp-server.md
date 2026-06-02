# Nimbus MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `nimbus mcp-server` CLI command that exposes the Nimbus local index to MCP-compatible editor AIs (Cursor, Claude Code, Copilot) as a read-only MCP stdio server.

**Architecture:** A thin adapter in `packages/cli` builds an MCP server (`@modelcontextprotocol/sdk`) whose six read-only tools each proxy to an existing Gateway **read** IPC method (`index.searchRanked`, `connector.listStatus`, `metrics.dora`) over the existing CLI `IPCClient`. The IPC connection is persistent with lazy reconnect. Results are projected to a compact, whitelisted shape so they don't overrun an editor LLM's context window. `nimbus mcp-server` prints a paste-ready config block; `nimbus mcp-server --stdio` runs the server.

**Tech Stack:** Bun + TypeScript 6 strict, `@modelcontextprotocol/sdk@1.29.0`, zod v4, the `@nimbus-dev/client` `IPCClient` (re-exported via `packages/cli/src/ipc-client/index.ts`).

**Spec:** `docs/superpowers/specs/2026-06-02-nimbus-mcp-server-editor-context-design.md`

**Branch:** `dev/asafgolombek/mcp-server` (already checked out; verify with `git rev-parse --abbrev-ref HEAD`).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/cli/src/mcp/adapter.ts` (create) | Connection deps + reconnect, result projection, the six tool specs, `buildMcpServer`, `runMcpServerStdio`. |
| `packages/cli/src/mcp/adapter.test.ts` (create) | Unit tests for projection, clamp, connection deps/reconnect, and each tool spec's IPC mapping + error handling. |
| `packages/cli/src/commands/mcp-server.ts` (create) | CLI command: arg parsing, config-block printing, `--stdio` runner (DI-seamed). |
| `packages/cli/src/commands/mcp-server.test.ts` (create) | Unit tests for arg parsing, config block, and the runMcpServer dispatch. |
| `packages/cli/src/commands/index.ts` (modify) | Re-export `runMcpServer` from the command barrel. |
| `packages/cli/src/index.ts` (modify) | Import `runMcpServer`; register `"mcp-server"` in `COMMAND_HANDLERS`. |
| `packages/cli/package.json` (modify) | Add `@modelcontextprotocol/sdk: 1.29.0` dependency. |
| `docs/CHANGELOG.md` (modify) | Log the delivery (per connector-docs convention). |
| `docs/cli-reference.md` (modify) | Document the `mcp-server` subcommand. |
| `docs/roadmap.md` (modify) | Tick the "Editor AI Context (MCP Native)" checkbox. |

---

## Task 1: Add the MCP SDK dependency to the CLI

**Files:**
- Modify: `packages/cli/package.json`

- [ ] **Step 1: Add the dependency, pinned to match the connectors**

Open `packages/cli/package.json` and add this line to the `"dependencies"` object (keep the object alphabetized if it already is; the exact pin `1.29.0` matches the version the mcp-connectors already use):

```json
"@modelcontextprotocol/sdk": "1.29.0",
```

- [ ] **Step 2: Install**

Run: `bun install`
Expected: completes without error; `node_modules/@modelcontextprotocol/sdk` resolves.

- [ ] **Step 3: Verify the import resolves**

Run: `bun -e "import('@modelcontextprotocol/sdk/server/mcp.js').then(m => console.log(typeof m.McpServer))"`
Expected: prints `function`.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/package.json bun.lock
git commit -m "build(cli): add @modelcontextprotocol/sdk for the mcp-server command"
```

---

## Task 2: Result projection + limit clamp helpers

These are pure functions — TDD them first. The heavy field on a `RankedIndexItem` is `rawMeta`; the projection drops it (keeping only a whitelisted slice) and maps `indexedType` → `type`.

**Files:**
- Create: `packages/cli/src/mcp/adapter.ts`
- Test: `packages/cli/src/mcp/adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/mcp/adapter.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { clampLimit, projectRankedItem, projectRankedItems } from "./adapter.ts";

describe("clampLimit", () => {
  it("defaults to 20 when undefined", () => {
    expect(clampLimit(undefined)).toBe(20);
  });
  it("caps at 50", () => {
    expect(clampLimit(1000)).toBe(50);
  });
  it("floors at 1", () => {
    expect(clampLimit(0)).toBe(1);
  });
  it("passes a valid value through, floored", () => {
    expect(clampLimit(7.9)).toBe(7);
  });
  it("defaults on non-finite", () => {
    expect(clampLimit(Number.NaN)).toBe(20);
  });
});

describe("projectRankedItem", () => {
  it("keeps core fields and maps indexedType -> type", () => {
    const out = projectRankedItem({
      name: "Fix login bug",
      service: "github",
      itemType: "file",
      indexedType: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
    expect(out).toEqual({
      name: "Fix login bug",
      service: "github",
      type: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
  });

  it("drops the raw rawMeta blob but keeps the whitelisted slice as meta", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: {
        state: "open",
        number: 42,
        author: "alice",
        secret_token: "should-not-leak",
        huge_blob: "x".repeat(10_000),
      },
    });
    expect(out["meta"]).toEqual({ state: "open", number: 42, author: "alice" });
    expect(JSON.stringify(out)).not.toContain("should-not-leak");
    expect(JSON.stringify(out)).not.toContain("huge_blob");
  });

  it("falls back to canonicalUrl when url is absent and keeps semanticSnippet", () => {
    const out = projectRankedItem({
      name: "Doc",
      service: "drive",
      indexedType: "file",
      score: 0.3,
      canonicalUrl: "https://example/canon",
      semanticSnippet: "…matched text…",
    });
    expect(out["url"]).toBe("https://example/canon");
    expect(out["semanticSnippet"]).toBe("…matched text…");
  });

  it("omits meta when no whitelisted keys are present", () => {
    const out = projectRankedItem({ name: "x", service: "s", indexedType: "file", score: 1, rawMeta: { mime_type: "text/plain" } });
    expect(out["meta"]).toBeUndefined();
  });
});

describe("projectRankedItems", () => {
  it("maps an array and tolerates a non-array input", () => {
    expect(projectRankedItems([{ name: "a", service: "s", indexedType: "pr", score: 1 }])).toHaveLength(1);
    expect(projectRankedItems(undefined)).toEqual([]);
    expect(projectRankedItems({})).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: FAIL — `Cannot find module './adapter.ts'`.

- [ ] **Step 3: Create the adapter file with the helpers**

Create `packages/cli/src/mcp/adapter.ts`:

```ts
const MCP_LIMIT_DEFAULT = 20;
const MCP_LIMIT_MAX = 50;
const META_WHITELIST = ["state", "number", "author", "status", "severity"] as const;

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
  const meta = r["rawMeta"];
  if (typeof meta === "object" && meta !== null) {
    const m = meta as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const k of META_WHITELIST) {
      if (m[k] !== undefined) {
        picked[k] = m[k];
      }
    }
    if (Object.keys(picked).length > 0) {
      out["meta"] = picked;
    }
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: PASS (all `clampLimit` / `projectRankedItem` / `projectRankedItems` tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -m "feat(cli): mcp adapter projection + limit-clamp helpers"
```

---

## Task 3: Connection deps with lazy reconnect

`createDeps(env)` returns an `AdapterDeps` that caches a connected client and re-creates it after a dropped connection. `env` is injectable so tests use fakes instead of real sockets. `createProductionDeps()` wires the real `IPCClient` + `readGatewayState`.

**Files:**
- Modify: `packages/cli/src/mcp/adapter.ts`
- Test: `packages/cli/src/mcp/adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/mcp/adapter.test.ts`:

```ts
import {
  createDeps,
  GatewayUnavailableError,
  isDisconnectError,
  type ConnectionEnv,
  type IpcCallable,
} from "./adapter.ts";

function fakeClient(call: IpcCallable["call"]): IpcCallable {
  return { call, disconnect: async () => {} };
}

describe("isDisconnectError", () => {
  it("recognizes transport-dead messages", () => {
    expect(isDisconnectError(new Error("IPC client is not connected"))).toBe(true);
    expect(isDisconnectError(new Error("IPC connection closed"))).toBe(true);
    expect(isDisconnectError(new Error("IPC connection error"))).toBe(true);
  });
  it("ignores unrelated errors", () => {
    expect(isDisconnectError(new Error("Local index is not available"))).toBe(false);
    expect(isDisconnectError("nope")).toBe(false);
  });
});

describe("createDeps", () => {
  it("throws GatewayUnavailableError when no gateway state", async () => {
    const env: ConnectionEnv = {
      readState: async () => undefined,
      connect: async () => fakeClient(async () => null),
    };
    await expect(createDeps(env).getClient()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("throws GatewayUnavailableError when connect fails", async () => {
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        throw new Error("ECONNREFUSED");
      },
    };
    await expect(createDeps(env).getClient()).rejects.toBeInstanceOf(GatewayUnavailableError);
  });

  it("caches the connected client across calls", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        return fakeClient(async () => "ok");
      },
    };
    const deps = createDeps(env);
    await deps.getClient();
    await deps.getClient();
    expect(connects).toBe(1);
  });

  it("reconnects after a dropped connection", async () => {
    let connects = 0;
    const env: ConnectionEnv = {
      readState: async () => ({ socketPath: "/tmp/x.sock" }),
      connect: async () => {
        connects += 1;
        return fakeClient(async () => {
          throw new Error("IPC connection closed");
        });
      },
    };
    const deps = createDeps(env);
    const c1 = await deps.getClient();
    await expect(c1.call("index.searchRanked", {})).rejects.toThrow("IPC connection closed");
    // The failed call invalidated the cache; the next getClient reconnects.
    await deps.getClient();
    expect(connects).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: FAIL — `createDeps` / `GatewayUnavailableError` / `isDisconnectError` not exported.

- [ ] **Step 3: Add the connection layer to `adapter.ts`**

Add these imports at the top of `packages/cli/src/mcp/adapter.ts` (above the existing constants):

```ts
import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";
```

Then append to the file:

```ts
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

/** True when an error indicates the IPC transport is dead and a reconnect is warranted. */
export function isDisconnectError(e: unknown): boolean {
  const m = e instanceof Error ? e.message : "";
  return m.includes("not connected") || m.includes("connection closed") || m.includes("connection error");
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
  const invalidate = (): void => {
    cached = null;
  };
  return {
    async getClient(): Promise<IpcCallable> {
      if (cached !== null) {
        return cached;
      }
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
      cached = makeReconnectingClient(raw, invalidate);
      return cached;
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: PASS (connection + reconnect tests green; Task 2 tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -m "feat(cli): mcp adapter connection deps with lazy reconnect"
```

---

## Task 4: Tool specs, runTool, and the MCP server builder

The six tools are defined as data (`TOOL_SPECS`) so the IPC mapping is unit-testable without a transport. `buildMcpServer` registers each into an `McpServer`; `runMcpServerStdio` connects a stdio transport.

**Files:**
- Modify: `packages/cli/src/mcp/adapter.ts`
- Test: `packages/cli/src/mcp/adapter.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/src/mcp/adapter.test.ts`:

```ts
import { buildMcpServer, TOOL_SPECS, type AdapterDeps } from "./adapter.ts";

type RecordedCall = { method: string; params?: unknown };

function recordingDeps(opts: {
  result?: unknown;
  fail?: "down" | "drop";
}): { deps: AdapterDeps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const client: IpcCallable = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      if (opts.fail === "drop") {
        throw new Error("IPC connection closed");
      }
      return opts.result as T;
    },
    disconnect: async () => {},
  };
  const deps: AdapterDeps = {
    getClient: async () => {
      if (opts.fail === "down") {
        throw new GatewayUnavailableError();
      }
      return client;
    },
  };
  return { deps, calls };
}

function spec(name: string) {
  const s = TOOL_SPECS.find((t) => t.name === name);
  if (s === undefined) {
    throw new Error(`no tool spec ${name}`);
  }
  return s;
}

describe("TOOL_SPECS", () => {
  it("exposes exactly the six read-only tools", () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(
      [
        "getConnectorStatus",
        "getDoraMetrics",
        "getRecentDeployments",
        "getRecentIncidents",
        "getRecentPullRequests",
        "searchIndex",
      ].sort(),
    );
  });

  it("searchIndex maps to index.searchRanked with clamped limit and contextChunks 0", async () => {
    const { deps, calls } = recordingDeps({ result: [{ name: "n", service: "github", indexedType: "pr", score: 1 }] });
    const res = await spec("searchIndex").run(deps, { query: "login bug", service: "github", limit: 1000 });
    expect(calls[0]).toEqual({
      method: "index.searchRanked",
      params: { name: "login bug", limit: 50, semantic: true, contextChunks: 0, service: "github" },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0]?.text).toContain('"type": "pr"');
  });

  it("getRecentPullRequests browses itemType pr by recency", async () => {
    const { deps, calls } = recordingDeps({ result: [] });
    await spec("getRecentPullRequests").run(deps, {});
    expect(calls[0]).toEqual({
      method: "index.searchRanked",
      params: { name: "", limit: 20, semantic: false, contextChunks: 0, itemType: "pr" },
    });
  });

  it("getRecentIncidents and getRecentDeployments pin their itemType", async () => {
    const inc = recordingDeps({ result: [] });
    await spec("getRecentIncidents").run(inc.deps, { service: "pagerduty" });
    expect(inc.calls[0]?.params).toMatchObject({ itemType: "incident", service: "pagerduty" });

    const dep = recordingDeps({ result: [] });
    await spec("getRecentDeployments").run(dep.deps, {});
    expect(dep.calls[0]?.params).toMatchObject({ itemType: "deployment" });
  });

  it("getConnectorStatus calls connector.listStatus and passes the result through", async () => {
    const { deps, calls } = recordingDeps({ result: [{ service: "github", health: "healthy" }] });
    const res = await spec("getConnectorStatus").run(deps, {});
    expect(calls[0]?.method).toBe("connector.listStatus");
    expect(res.content[0]?.text).toContain("healthy");
  });

  it("getDoraMetrics calls metrics.dora with service and since", async () => {
    const { deps, calls } = recordingDeps({ result: { deploymentFrequency: null } });
    await spec("getDoraMetrics").run(deps, { service: "payments", since: "30d" });
    expect(calls[0]).toEqual({ method: "metrics.dora", params: { service: "payments", since: "30d" } });
  });

  it("returns an isError result with guidance when the Gateway is down", async () => {
    const { deps } = recordingDeps({ fail: "down" });
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nimbus start");
  });

  it("returns an isError result (not a throw) on a dropped connection", async () => {
    const { deps } = recordingDeps({ result: [], fail: "drop" });
    const res = await spec("searchIndex").run(deps, { query: "x" });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain("nimbus start");
  });
});

describe("buildMcpServer", () => {
  it("registers all six tools without throwing", () => {
    const { deps } = recordingDeps({ result: [] });
    const server = buildMcpServer(deps);
    expect(server).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: FAIL — `TOOL_SPECS` / `buildMcpServer` not exported.

- [ ] **Step 3: Add the tool layer to `adapter.ts`**

Add these imports to the top of `packages/cli/src/mcp/adapter.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
```

Then append to the file:

```ts
export interface ToolResult {
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
async function runTool(deps: AdapterDeps, fn: (c: IpcCallable) => Promise<ToolResult>): Promise<ToolResult> {
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
  itemType?: string;
  service?: string;
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

async function searchAndProject(client: IpcCallable, params: Record<string, unknown>): Promise<ToolResult> {
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
    description: "List recent incidents from the local index (most recent first). Optionally filter by service.",
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
    description: "List recent deployments from the local index (most recent first). Optionally filter by service.",
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
        const params: Record<string, unknown> = { service: optString(args, "service") ?? "" };
        const since = optString(args, "since");
        if (since !== undefined) {
          params["since"] = since;
        }
        return jsonResult(await c.call("metrics.dora", params));
      }),
  },
];

/** Build the MCP server with all six read-only tools registered. */
export function buildMcpServer(deps: AdapterDeps): McpServer {
  const server = new McpServer({ name: "nimbus", version: "0.1.0" });
  for (const s of TOOL_SPECS) {
    server.tool(s.name, s.description, s.schema, (args: unknown) =>
      s.run(deps, asRecord(args)),
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
```

> Note on the `getDoraMetrics` test: it expects `params` to equal `{ service, since }`. Because `since` is provided in that test, the conditional includes it — the assertion matches. When `since` is omitted, only `{ service }` is sent.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/mcp/adapter.test.ts`
Expected: PASS (all tool-mapping, error-handling, and builder tests green).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/mcp/adapter.ts packages/cli/src/mcp/adapter.test.ts
git commit -m "feat(cli): six read-only mcp tools + stdio server builder"
```

---

## Task 5: The `nimbus mcp-server` CLI command

Parses args into help / config / stdio; prints the paste-ready config block; runs the stdio server via injectable deps.

**Files:**
- Create: `packages/cli/src/commands/mcp-server.ts`
- Test: `packages/cli/src/commands/mcp-server.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/commands/mcp-server.test.ts`:

```ts
import { afterAll, describe, expect, it } from "bun:test";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import type { AdapterDeps } from "../mcp/adapter.ts";
import {
  formatConfigBlock,
  MCP_SERVER_CONFIG,
  parseMcpServerArgs,
  runMcpServer,
  type RunMcpServerDeps,
} from "./mcp-server.ts";

const out = captureOutput();
afterAll(() => {
  out.restore();
});

describe("parseMcpServerArgs", () => {
  it("returns help on help flags", () => {
    expect(parseMcpServerArgs(["help"])).toEqual({ kind: "help" });
    expect(parseMcpServerArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseMcpServerArgs(["-h"])).toEqual({ kind: "help" });
  });
  it("returns stdio when --stdio present", () => {
    expect(parseMcpServerArgs(["--stdio"])).toEqual({ kind: "stdio" });
  });
  it("defaults to config", () => {
    expect(parseMcpServerArgs([])).toEqual({ kind: "config" });
  });
});

describe("formatConfigBlock / MCP_SERVER_CONFIG", () => {
  it("embeds a valid JSON block pointing at `mcp-server --stdio`", () => {
    const block = formatConfigBlock();
    const jsonStart = block.indexOf("{");
    const parsed = JSON.parse(block.slice(jsonStart)) as typeof MCP_SERVER_CONFIG;
    expect(parsed.mcpServers.nimbus.command).toBe("nimbus");
    expect(parsed.mcpServers.nimbus.args).toEqual(["mcp-server", "--stdio"]);
  });
});

function fakeRunDeps(): { deps: RunMcpServerDeps; ran: { count: number } } {
  const ran = { count: 0 };
  const adapterDeps: AdapterDeps = { getClient: async () => ({ call: async () => null, disconnect: async () => {} }) };
  return {
    ran,
    deps: {
      makeDeps: () => adapterDeps,
      runStdio: async (d) => {
        expect(d).toBe(adapterDeps);
        ran.count += 1;
      },
    },
  };
}

describe("runMcpServer", () => {
  it("prints the config block by default and does not run the server", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer([], deps);
    expect(out.stdout).toContain('"mcp-server"');
    expect(ran.count).toBe(0);
  });

  it("prints help on --help", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer(["--help"], deps);
    expect(out.stdout).toContain("nimbus mcp-server");
    expect(ran.count).toBe(0);
  });

  it("runs the stdio server on --stdio using injected deps", async () => {
    out.reset();
    const { deps, ran } = fakeRunDeps();
    await runMcpServer(["--stdio"], deps);
    expect(ran.count).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/cli/src/commands/mcp-server.test.ts`
Expected: FAIL — `Cannot find module './mcp-server.ts'`.

- [ ] **Step 3: Create the command**

Create `packages/cli/src/commands/mcp-server.ts`:

```ts
import { type AdapterDeps, createProductionDeps, runMcpServerStdio } from "../mcp/adapter.ts";

export const MCP_SERVER_CONFIG = {
  mcpServers: {
    nimbus: {
      command: "nimbus",
      args: ["mcp-server", "--stdio"],
    },
  },
} as const;

export function formatConfigBlock(): string {
  return [
    "Add this to your editor's MCP config (e.g. mcp.json). `nimbus` must be on your PATH:",
    "",
    JSON.stringify(MCP_SERVER_CONFIG, null, 2),
  ].join("\n");
}

const HELP = `nimbus mcp-server — expose the Nimbus local index to editor AIs over MCP

Usage:
  nimbus mcp-server            Print the MCP server config block to paste into your editor
  nimbus mcp-server --stdio    Run the MCP server over stdio (your editor launches this)

Read-only tools: searchIndex, getConnectorStatus, getRecentIncidents,
getRecentPullRequests, getRecentDeployments, getDoraMetrics.
The Gateway must be running (start it with: nimbus start).`;

export type McpServerArgs = { kind: "help" } | { kind: "config" } | { kind: "stdio" };

export function parseMcpServerArgs(args: string[]): McpServerArgs {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    return { kind: "help" };
  }
  if (args.includes("--stdio")) {
    return { kind: "stdio" };
  }
  return { kind: "config" };
}

export interface RunMcpServerDeps {
  makeDeps(): AdapterDeps;
  runStdio(deps: AdapterDeps): Promise<void>;
}

const PRODUCTION_DEPS: RunMcpServerDeps = {
  makeDeps: createProductionDeps,
  runStdio: runMcpServerStdio,
};

export async function runMcpServer(
  args: string[],
  deps: RunMcpServerDeps = PRODUCTION_DEPS,
): Promise<void> {
  const parsed = parseMcpServerArgs(args);
  if (parsed.kind === "help") {
    console.log(HELP);
    return;
  }
  if (parsed.kind === "config") {
    console.log(formatConfigBlock());
    return;
  }
  await deps.runStdio(deps.makeDeps());
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/cli/src/commands/mcp-server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/mcp-server.ts packages/cli/src/commands/mcp-server.test.ts
git commit -m "feat(cli): nimbus mcp-server command (config print + --stdio runner)"
```

---

## Task 6: Register the command in the CLI dispatcher

**Files:**
- Modify: `packages/cli/src/commands/index.ts`
- Modify: `packages/cli/src/index.ts`

- [ ] **Step 1: Re-export from the command barrel**

In `packages/cli/src/commands/index.ts`, add an export alongside the other command re-exports (match the file's existing export style — most are `export { runX } from "./x.ts";`):

```ts
export { runMcpServer } from "./mcp-server.ts";
```

- [ ] **Step 2: Import and register in the dispatcher**

In `packages/cli/src/index.ts`, add `runMcpServer` to the import list from `./commands/index.ts` (keep alphabetical-ish ordering near `runMetricsCli`):

```ts
  runMcpServer,
```

Then add this entry to the `COMMAND_HANDLERS` object (e.g. right after the `metrics: runMetricsCli,` line):

```ts
  "mcp-server": runMcpServer,
```

- [ ] **Step 3: Verify the command dispatches (config branch prints, no Gateway needed)**

Run: `bun packages/cli/src/index.ts mcp-server`
Expected: prints the config block containing `"mcp-server"` and `"--stdio"`; exits 0. (Banner is auto-suppressed because stdout is piped.)

- [ ] **Step 4: Verify `--stdio` starts and serves over stdio**

Run: `echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun packages/cli/src/index.ts mcp-server --stdio`
Expected: a single JSON-RPC line on stdout whose `result.tools` lists the six tool names (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`, `getDoraMetrics`). The process then waits on stdin; press Ctrl-C to exit. No banner/log text pollutes stdout.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/index.ts packages/cli/src/index.ts
git commit -m "feat(cli): wire mcp-server into the command dispatcher"
```

---

## Task 7: Documentation

**Files:**
- Modify: `docs/CHANGELOG.md`
- Modify: `docs/cli-reference.md`
- Modify: `docs/roadmap.md`

- [ ] **Step 1: Add a CHANGELOG entry**

Open `docs/CHANGELOG.md`, find the most recent dated heading at the top, and add a bullet under today's date (`2026-06-02`) — create the date heading if it does not exist, matching the file's existing heading format:

```markdown
- **`nimbus mcp-server`** — expose the local index to MCP-compatible editor AIs (Cursor, Claude Code, Copilot) as a read-only MCP stdio server. Six read-only tools (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`, `getDoraMetrics`) proxy to existing Gateway read IPC methods. `nimbus mcp-server` prints the editor config block; `nimbus mcp-server --stdio` runs the server. No write surface, no HITL surface.
```

- [ ] **Step 2: Document the subcommand in the CLI reference**

Open `docs/cli-reference.md` and add a section for `mcp-server`, matching the formatting of the surrounding subcommand entries:

```markdown
## `nimbus mcp-server`

Expose the Nimbus local index to MCP-compatible editor AIs as a read-only MCP stdio server.

```
nimbus mcp-server            # print the MCP config block to paste into your editor (mcp.json)
nimbus mcp-server --stdio    # run the server over stdio (your editor launches this)
```

The Gateway must be running (`nimbus start`). Tools are read-only:
`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getRecentPullRequests`,
`getRecentDeployments`, `getDoraMetrics`. No write or HITL surface is exposed.
```

- [ ] **Step 3: Tick the roadmap checkbox**

In `docs/roadmap.md`, find the line beginning `- [ ] **Native Cursor / Claude Code / Copilot context exposure**` (under "Editor AI Context (MCP Native)") and change `- [ ]` to `- [x]`. Append a short delivered note at the end of that bullet:

```markdown
 — **Delivered 2026-06-02** as `nimbus mcp-server` (CLI-owned read-only stdio adapter; tool renamed `getOpenPRs` → `getRecentPullRequests` since the index cannot pre-filter PR state; added `getRecentDeployments` + `getDoraMetrics`).
```

- [ ] **Step 4: Verify docs lint passes**

Run: `bun run lint:markdown`
Expected: PASS (no markdownlint errors).

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md docs/cli-reference.md docs/roadmap.md
git commit -m "docs: document nimbus mcp-server + tick roadmap"
```

---

## Task 8: Full verification before pushing

**Files:** none (verification only)

- [ ] **Step 1: Run the new tests together**

Run: `bun test packages/cli/src/mcp/ packages/cli/src/commands/mcp-server.test.ts`
Expected: PASS, all green.

- [ ] **Step 2: Typecheck the workspace**

Run: `bun run typecheck`
Expected: no new errors in `packages/cli`. (Per the project memory there may be ~pre-existing `nimbus-mcp` dependency errors unrelated to this change — confirm none of the reported errors reference `src/mcp/adapter.ts`, `src/commands/mcp-server.ts`, or `src/index.ts`.)

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: PASS (Biome clean). Fix any reported issues in the new files.

- [ ] **Step 4: Run the fast preflight gates**

Run: `bun run preflight:fast`
Expected: all cheap static gates pass. Address any failure before pushing.

- [ ] **Step 5: Final confirmation commit (if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore(cli): lint/format fixups for mcp-server"
```

---

## Notes for the implementer

- **Strict mode / no `any`:** all external/tool inputs are typed `unknown` and narrowed via the `opt*` helpers and `asRecord`. Do not introduce `any`.
- **stdout hygiene:** `--stdio` must keep stdout exclusively for the MCP transport. The CLI banner is auto-suppressed when stdout is piped (`shouldSuppressBanner`), and the file logger never writes to stdout — do not add `console.log` to any code path reachable under `--stdio`.
- **Why `getClient()` not `connect()`:** the persistent-with-reconnect lifecycle lives entirely in `createDeps`; tool code only ever asks for "a usable client", so the reconnect concern is in exactly one place.
- **No Gateway API change:** every tool proxies an existing read method. If you find yourself wanting to add a Gateway IPC method, stop — that is out of scope for this plan (see the spec's Non-Goals).
- **Security invariants:** I11 (`wrapToolOutput`) does not apply — output goes to the editor's LLM, not the Nimbus engine. No HITL action type is reachable. No Tauri allowlist change. The `META_WHITELIST` is load-bearing: it prevents arbitrary connector metadata leaking to the editor LLM — keep it tight.
```
