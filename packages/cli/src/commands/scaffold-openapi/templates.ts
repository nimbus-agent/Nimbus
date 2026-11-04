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
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_CHARS = 65_536;
export const TRUNCATED_MARKER = "\\n[truncated]";
export const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** Bytes read from a response before the rest is dropped (then cut to MAX_RESPONSE_CHARS). */
export const MAX_READ_BYTES = 4 * MAX_RESPONSE_CHARS;

const HOSTS: ReadonlySet<string> = new Set(TABLE.hosts);

/** What an HTTP header value may carry here: printable ASCII, no CR, LF or NUL. */
const HEADER_SAFE = /^[\\x20-\\x7e]+$/;
/** An RFC 7230 token: the only shape a header name may have. */
const HEADER_TOKEN = /^[!#$%&'*+.^_\`|~0-9A-Za-z-]+$/;
/** Headers this extension sets itself. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(["accept", "authorization", "content-type"]);
/** Headers that would redirect or reframe the request (a caller-set Host is sent as is). */
const TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "content-length",
  "cookie",
  "expect",
  "host",
  "keep-alive",
  "te",
  "transfer-encoding",
  "upgrade",
]);
/**
 * A character the URL parser rewrites in a path: "\\" (read as "/"), a C0 control, DEL, or a
 * space (trimmed at the end, so "/x/.. " resolves ".."; a path spells a space %20 anyway).
 */
function isRewrittenChar(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return ch === "\\\\" || code <= 0x20 || code === 0x7f;
}
/** A path segment the URL parser resolves as "." or ".." (it decodes %2e). */
const DOT_SEGMENT = /^(?:\\.|%2e){1,2}$/i;

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
  // The URL parser reads "\\" as "/" and drops tab, CR and LF before it resolves dot-segments,
  // so "/a/..\\b" or "/a/.\\t./b" would climb. Filled values are percent-encoded and cannot add one.
  if ([...op.path].some(isRewrittenChar)) {
    throw new RequestError(\`\${op.tool}: the path has a character the URL parser would rewrite\`);
  }
  let path = op.path;
  for (const p of op.params) {
    if (p.in !== "path") continue;
    const value = ownValue(args, p.arg);
    if (value === undefined) continue;
    path = path.split(\`{\${p.name}}\`).join(encodeURIComponent(asText(value)));
  }
  // encodeURIComponent keeps dots, and the URL parser resolves "." and ".." (also spelled with
  // %2e) as dot-segments, which would climb out of the operation's path and the server's base
  // path. Checked on the FILLED path, so "{a}..{b}" with empty values is caught too.
  if (path.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new RequestError(\`\${op.tool}: the filled path would have a "." or ".." segment\`);
  }
  return path;
}

/**
 * Whatever the URL parser normalised, the request stays under the server's own base path (such
 * as /v1) and carries no "." or ".." segment.
 */
export function assertWithinBase(op: OperationDef, url: URL): void {
  let base = new URL(op.server).pathname;
  while (base.endsWith("/")) base = base.slice(0, -1);
  const inside = url.pathname === base || url.pathname.startsWith(\`\${base}/\`);
  if (!inside || url.pathname.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new RequestError(\`\${op.tool}: the URL would leave the server's base path\`);
  }
}

function assertRequired(op: OperationDef, args: Args): void {
  for (const p of op.params) {
    if (p.required && ownValue(args, p.arg) === undefined) {
      throw new RequestError(\`missing required parameter \${p.arg}\`);
    }
  }
}

/** Not a header name at all, or one that would redirect or reframe the request. */
function isTransportHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return !HEADER_TOKEN.test(name) || TRANSPORT_HEADERS.has(lower) || lower.startsWith("proxy-");
}

/** A header name never taken from a parameter. Checked again here: the table is hand-editable. */
function isForbiddenHeader(name: string): boolean {
  return isTransportHeader(name) || RESERVED_HEADERS.has(name.toLowerCase());
}

function placeParams(op: OperationDef, args: Args, url: URL, headers: Headers): void {
  for (const p of op.params) {
    const value = ownValue(args, p.arg);
    if (value === undefined || p.in === "path") continue;
    if (p.in === "header") {
      if (isForbiddenHeader(p.name)) {
        throw new RequestError(
          \`the header parameter \${p.arg} names a header this extension may not set\`,
        );
      }
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
  // Checked here, not left to Headers: its error message would quote the secret itself.
  if (!HEADER_SAFE.test(value)) {
    throw new RequestError(\`credential \${name} contains characters an HTTP header cannot carry\`);
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
    const name = cred.name ?? "";
    if (isTransportHeader(name)) {
      throw new RequestError("the credential names a header this extension may not set");
    }
    headers.set(name, value);
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
/**
 * The parsed request URL, refused unless it is https to a declared host and stays under the
 * server's base path. Every request URL goes through here (exported so a test can pin that).
 */
export function checkedUrl(op: OperationDef, href: string): URL {
  const url = new URL(href);
  if (url.protocol !== "https:" || !HOSTS.has(url.host)) {
    throw new RequestError(\`\${url.host} is not a host this extension declares\`);
  }
  assertWithinBase(op, url);
  return url;
}

export function buildRequest(
  op: OperationDef,
  args: Args,
  env: Env,
): { url: string; init: RequestInit } {
  assertRequired(op, args);
  const url = checkedUrl(op, joinUrl(op.server, fillPath(op, args)));
  const headers = new Headers();
  placeParams(op, args, url, headers);
  const body = placeBody(op, args, headers);
  placeCredential(op.credential, env, url, headers);
  const init: RequestInit = {
    method: op.method,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  };
  if (body !== undefined) init.body = body;
  return { url: url.href, init };
}

/**
 * At most MAX_READ_BYTES of the body, decoded as UTF-8; the rest is never read. UTF-8 spends at
 * most 3 bytes per UTF-16 unit, so a body cut here always decodes to more than
 * MAX_RESPONSE_CHARS units and is always truncated, with the marker, below.
 */
async function readCapped(res: Response): Promise<string> {
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < MAX_READ_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= MAX_READ_BYTES) await reader.cancel();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes.subarray(0, MAX_READ_BYTES));
}

/** The body cut at MAX_RESPONSE_CHARS, never between the two halves of a surrogate pair. */
function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  const last = text.charCodeAt(MAX_RESPONSE_CHARS - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? MAX_RESPONSE_CHARS - 1 : MAX_RESPONSE_CHARS;
  return text.slice(0, end) + TRUNCATED_MARKER;
}

/** A redirect target as origin and path only: a query or fragment may carry a secret. */
function describeLocation(location: string | null, base: string): string {
  if (location === null) return "(no Location header)";
  try {
    const target = new URL(location, base);
    return \`\${target.origin}\${target.pathname}\`;
  } catch {
    return "(an unusable Location header)";
  }
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
    const target = describeLocation(res.headers.get("location"), url);
    return \`HTTP \${res.status}; redirect to \${target} not followed\`;
  }
  return \`HTTP \${res.status}\\n\${truncate(await readCapped(res))}\`;
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

import {
  type Args,
  callOperation,
  type Env,
  type OperationDef,
  RequestError,
  TABLE,
} from "./request.ts";

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
      return { content: [{ type: "text", text: errorText(e) }], isError: true };
    }
  });
  return server;
}

/**
 * What a failed call tells the model. Only this extension's own refusals are quoted: any other
 * error (from fetch, Headers or URL) can carry a header value — a credential — in its message.
 */
export function errorText(e: unknown): string {
  if (e instanceof RequestError) return e.message;
  const kind = e instanceof Error ? e.name : typeof e;
  return \`the request could not be sent (\${kind})\`;
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
