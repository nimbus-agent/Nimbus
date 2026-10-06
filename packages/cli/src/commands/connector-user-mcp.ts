import type { IPCClient } from "../ipc-client/index.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

/** The gateway's `connector.userMcpCall` result, restated for the IPC boundary. */
export type UserMcpCallOutcome =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; reason: string };

export interface UserMcpDeps {
  call(method: string, params: unknown): Promise<unknown>;
  log(line: string): void;
  error(line: string): void;
}

const TOOLS_USAGE = "Usage: nimbus connector tools <mcp_id> [--json]";
const CALL_USAGE = "Usage: nimbus connector call <mcp_id> <tool> [--input <json>] [--json]";

/** Gateway refusals that mean "nothing ran because of what you asked", not a failure. */
const REFUSAL_CODES = ["ERR_USER_MCP_UNKNOWN_TOOL", "ERR_USER_MCP_NOT_REGISTERED"] as const;

function defaultDeps(): UserMcpDeps {
  return {
    // Default consent is the interactive prompt; `call` raises an I42 approval on this terminal.
    call: (method, params) =>
      withGatewayIpc((c: IPCClient) => c.call<unknown>(method, params), undefined, {
        requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
      }),
    log: (l) => console.log(l),
    error: (l) => console.error(l),
  };
}

function fail(deps: UserMcpDeps, message: string, code: number): void {
  deps.error(message);
  process.exitCode = code;
}

function reportError(deps: UserMcpDeps, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const refused = REFUSAL_CODES.some((c) => message.includes(c));
  fail(deps, message, refused ? 2 : 1);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function renderResult(result: unknown): string {
  if (isPlainObject(result) && Array.isArray(result["content"])) {
    const texts = result["content"].flatMap((part: unknown) =>
      isPlainObject(part) && typeof part["text"] === "string" ? [part["text"]] : [],
    );
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return JSON.stringify(result) ?? "null";
}

export async function runConnectorTools(tail: string[], deps?: UserMcpDeps): Promise<void> {
  const d = deps ?? defaultDeps();
  const json = tail.includes("--json");
  const positional = tail.filter((a) => a !== "--json");
  const serviceId = positional[0];
  if (serviceId === undefined || positional.length !== 1) {
    fail(d, TOOLS_USAGE, 1);
    return;
  }
  try {
    const res = (await d.call("connector.userMcpTools", { serviceId })) as {
      tools: Array<{ name: string; description: string }>;
    };
    if (json) {
      d.log(JSON.stringify(res, null, 2));
      return;
    }
    for (const t of res.tools) {
      d.log(`${t.name} — ${t.description}`);
    }
  } catch (e) {
    reportError(d, e);
  }
}

type CallArgs = { serviceId: string; tool: string; input?: Record<string, unknown>; json: boolean };

function parseCallArgs(tail: string[]): CallArgs | string {
  const positional: string[] = [];
  let json = false;
  let inputRaw: string | undefined;
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i] as string;
    if (a === "--json") {
      json = true;
    } else if (a === "--input") {
      inputRaw = tail[++i];
      if (inputRaw === undefined) {
        return `Missing value for --input\n${CALL_USAGE}`;
      }
    } else {
      positional.push(a);
    }
  }
  const [serviceId, tool] = positional;
  if (serviceId === undefined || tool === undefined || positional.length !== 2) {
    return CALL_USAGE;
  }
  if (inputRaw === undefined) {
    return { serviceId, tool, json };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(inputRaw);
  } catch {
    return `--input must be a JSON object\n${CALL_USAGE}`;
  }
  if (!isPlainObject(parsed)) {
    return `--input must be a JSON object\n${CALL_USAGE}`;
  }
  return { serviceId, tool, input: parsed, json };
}

export async function runConnectorCall(tail: string[], deps?: UserMcpDeps): Promise<void> {
  const d = deps ?? defaultDeps();
  const args = parseCallArgs(tail);
  if (typeof args === "string") {
    fail(d, args, 1);
    return;
  }
  const params = {
    serviceId: args.serviceId,
    tool: args.tool,
    ...(args.input === undefined ? {} : { input: args.input }),
  };
  try {
    const res = (await d.call("connector.userMcpCall", params)) as UserMcpCallOutcome;
    if (res.status === "rejected") {
      if (args.json) {
        d.log(JSON.stringify(res, null, 2));
      } else {
        d.log(`Refused: ${res.reason}`);
      }
      process.exitCode = 2;
      return;
    }
    d.log(args.json ? JSON.stringify(res, null, 2) : renderResult(res.result));
  } catch (e) {
    reportError(d, e);
  }
}
