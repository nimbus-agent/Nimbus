/**
 * The fixed sources `nimbus scaffold extension --from-openapi` writes. They are constants: no
 * value from the OpenAPI document is ever substituted into them (the document's text lives only
 * in `src/operations.json`, written with `JSON.stringify`). The one substitution is `__NAME__` in
 * `src/tools.ts` and `src/tools.test.ts`, replaced by the already-validated extension name, as the
 * plain scaffold does.
 */

/** `src/request.ts`: dependency-free, so a test can import it from anywhere and inject `fetch`. */
export const OPENAPI_REQUEST_TS = `/**
 * Builds and sends one operation's request. Everything it sends comes from src/operations.json.
 * Names there come from the OpenAPI document (a parameter may be called "__proto__"), so every
 * lookup by such a name checks Object.hasOwn first.
 */
import table from "./operations.json";

export interface ParamDef {
  readonly name: string;
  readonly in: "path" | "query" | "header";
  readonly arg: string;
  readonly required: boolean;
}

export interface CredentialUse {
  readonly kind: "header" | "query" | "bearer" | "basic";
  readonly name?: string;
  readonly env: string;
  readonly passwordEnv?: string;
}

export interface OperationDef {
  readonly tool: string;
  readonly method: string;
  readonly path: string;
  readonly server: string;
  readonly params: readonly ParamDef[];
  readonly body: "json" | "unsupported" | null;
  readonly bodyRequired: boolean;
  readonly inputSchema: Record<string, unknown>;
  readonly description: string;
  readonly credential: CredentialUse | null;
}

export interface OperationTable {
  readonly hosts: readonly string[];
  readonly operations: readonly OperationDef[];
}

export type Args = Record<string, unknown>;
export type Env = Record<string, string | undefined>;

export const TABLE = table as unknown as OperationTable;
export const TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_CHARS = 65_536;
export const TRUNCATED_MARKER = "\\n[truncated]";
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

const HOSTS: ReadonlySet<string> = new Set(TABLE.hosts);

/** A request this extension refuses to send; the message says why. */
export class RequestError extends Error {}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** \`<server without trailing />\` + \`/\` + \`<path without leading />\`, so a base path is kept. */
function joinUrl(server: string, path: string): string {
  let base = server;
  while (base.endsWith("/")) base = base.slice(0, -1);
  let rest = path;
  while (rest.startsWith("/")) rest = rest.slice(1);
  return \`\${base}/\${rest}\`;
}

function fillPath(op: OperationDef, args: Args): string {
  let path = op.path;
  for (const p of op.params) {
    if (p.in !== "path") continue;
    const value = ownValue(args, p.arg);
    if (value === undefined) continue;
    const text = asText(value);
    // encodeURIComponent keeps dots, and the URL parser resolves "." and ".." as dot-segments,
    // which would climb out of the operation's path and the server's base path.
    if (text === "." || text === "..") {
      throw new RequestError(\`path parameter \${p.arg} may not be "." or ".."\`);
    }
    path = path.split(\`{\${p.name}}\`).join(encodeURIComponent(text));
  }
  return path;
}

function assertRequired(op: OperationDef, args: Args): void {
  for (const p of op.params) {
    if (p.required && ownValue(args, p.arg) === undefined) {
      throw new RequestError(\`missing required parameter \${p.arg}\`);
    }
  }
}

function placeParams(op: OperationDef, args: Args, url: URL, headers: Headers): void {
  for (const p of op.params) {
    const value = ownValue(args, p.arg);
    if (value === undefined || p.in === "path") continue;
    if (p.in === "header") {
      headers.set(p.name, asText(value));
    } else if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(p.name, asText(item));
    } else {
      url.searchParams.append(p.name, asText(value));
    }
  }
}

function secret(env: Env, name: string): string {
  const value = Object.hasOwn(env, name) ? env[name] : undefined;
  if (value === undefined || value === "") {
    throw new RequestError(
      \`the credential in \${name} is not set; set it with nimbus extension credential set\`,
    );
  }
  return value;
}

function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Applied after every parameter, so no parameter can replace it. */
function placeCredential(cred: CredentialUse | null, env: Env, url: URL, headers: Headers): void {
  if (cred === null) return;
  const value = secret(env, cred.env);
  if (cred.kind === "bearer") {
    headers.set("authorization", \`Bearer \${value}\`);
  } else if (cred.kind === "basic") {
    const password = secret(env, cred.passwordEnv ?? "");
    headers.set("authorization", \`Basic \${base64(\`\${value}:\${password}\`)}\`);
  } else if (cred.kind === "header") {
    headers.set(cred.name ?? "", value);
  } else {
    url.searchParams.set(cred.name ?? "", value);
  }
}

/** An optional non-JSON body is left out; a required one refuses the call. */
function placeBody(op: OperationDef, args: Args, headers: Headers): string | undefined {
  if (op.body === "unsupported" && op.bodyRequired) {
    throw new RequestError(
      \`\${op.tool} requires a request body that is not JSON; edit src/request.ts to send it\`,
    );
  }
  const body = op.body === "json" ? ownValue(args, "body") : undefined;
  if (body === undefined) return undefined;
  const text = JSON.stringify(body);
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RequestError(\`the request body is larger than \${MAX_BODY_BYTES} bytes\`);
  }
  headers.set("content-type", "application/json");
  return text;
}

/** The URL and init for one call; throws RequestError before anything is sent. */
export function buildRequest(
  op: OperationDef,
  args: Args,
  env: Env,
): { url: string; init: RequestInit } {
  assertRequired(op, args);
  const url = new URL(joinUrl(op.server, fillPath(op, args)));
  if (url.protocol !== "https:" || !HOSTS.has(url.host)) {
    throw new RequestError(\`\${url.host} is not a host this extension declares\`);
  }
  const headers = new Headers();
  placeParams(op, args, url, headers);
  const body = placeBody(op, args, headers);
  placeCredential(op.credential, env, url, headers);
  const init: RequestInit = {
    method: op.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) init.body = body;
  return { url: url.href, init };
}

/** The body cut at MAX_RESPONSE_CHARS, never between the two halves of a surrogate pair. */
function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  const last = text.charCodeAt(MAX_RESPONSE_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_RESPONSE_CHARS - 1 : MAX_RESPONSE_CHARS;
  return text.slice(0, end) + TRUNCATED_MARKER;
}

/** Sends the call and returns the status and body as text. A redirect is never followed. */
export async function callOperation(
  op: OperationDef,
  args: Args,
  deps: { fetch: typeof fetch; env: Env },
): Promise<string> {
  const { url, init } = buildRequest(op, args, deps.env);
  const res = await deps.fetch(url, init);
  if (res.status === 304) {
    await res.body?.cancel();
    return "HTTP 304 not modified";
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    return \`HTTP \${res.status}; redirect to \${res.headers.get("location") ?? "(no Location header)"} not followed\`;
  }
  return \`HTTP \${res.status}\\n\${truncate(await res.text())}\`;
}
`;

/** `src/tools.ts`: the low-level MCP server, serving each tool's raw JSON input schema. */
export const OPENAPI_TOOLS_TS = `import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { type Args, callOperation, type Env, type OperationDef, TABLE } from "./request.ts";

export interface ServerDeps {
  readonly fetch?: typeof fetch;
  readonly env?: Env;
}

/** Tool name to operation, on a null prototype so "toString" or "__proto__" finds nothing. */
function toolMap(): Record<string, OperationDef> {
  const map = Object.create(null) as Record<string, OperationDef>;
  for (const op of TABLE.operations) map[op.tool] = op;
  return map;
}

/** Build the server. Exported so the test can drive it in memory with its own fetch and env. */
export function createServer(deps: ServerDeps = {}): Server {
  const send = deps.fetch ?? fetch;
  const env = deps.env ?? process.env;
  const tools = toolMap();
  const server = new Server(
    { name: "__NAME__", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TABLE.operations.map((op) => ({
      name: op.tool,
      description: op.description,
      inputSchema: op.inputSchema as { type: "object" },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const op = Object.hasOwn(tools, name) ? tools[name] : undefined;
    if (op === undefined) throw new McpError(ErrorCode.InvalidParams, \`Unknown tool: \${name}\`);
    const args: Args = request.params.arguments ?? {};
    try {
      const text = await callOperation(op, args, { fetch: send, env });
      return { content: [{ type: "text", text }] };
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text }], isError: true };
    }
  });
  return server;
}
`;

/** `src/tools.test.ts`: offline — every call goes to an injected fetch, never the network. */
export const OPENAPI_TOOLS_TEST_TS = `import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { type Env, type OperationDef, TABLE } from "./request.ts";
import { createServer } from "./tools.ts";

const urls: string[] = [];

const offlineFetch = (async (input: string | URL | Request) => {
  urls.push(String(input));
  return new Response("ok", { status: 200 });
}) as typeof fetch;

/** A placeholder value for every credential the table uses. */
function testEnv(): Env {
  const env: Env = {};
  for (const op of TABLE.operations) {
    if (op.credential === null) continue;
    env[op.credential.env] = "test";
    if (op.credential.passwordEnv !== undefined) env[op.credential.passwordEnv] = "test";
  }
  return env;
}

/** Every parameter set to "1", and an empty JSON body where one is taken. */
function sampleArgs(op: OperationDef): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const p of op.params) args[p.arg] = "1";
  if (op.body === "json") args["body"] = {};
  return args;
}

async function connected(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer({ fetch: offlineFetch, env: testEnv() }).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("__NAME__", () => {
  test("lists one tool per operation", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TABLE.operations.map((op) => op.tool));
  });

  test("an unknown tool is an error", async () => {
    const client = await connected();
    for (const name of ["no_such_tool", "toString", "__proto__"]) {
      await expect(client.callTool({ name, arguments: {} })).rejects.toThrow(/Unknown tool/);
    }
  });

  test("every tool calls a declared host through the injected fetch", async () => {
    const client = await connected();
    for (const op of TABLE.operations) {
      urls.length = 0;
      const out = await client.callTool({ name: op.tool, arguments: sampleArgs(op) });
      if (op.body === "unsupported" && op.bodyRequired) {
        expect(out.isError).toBe(true);
        expect(urls).toEqual([]);
        continue;
      }
      expect(out.content).toEqual([{ type: "text", text: "HTTP 200\\nok" }]);
      expect(urls).toHaveLength(1);
      expect(TABLE.hosts).toContain(new URL(urls[0] ?? "").host);
    }
  });
});
`;
