import type { IPCClient } from "../ipc-client/index.ts";
import { declareCliClientKind } from "../lib/declare-client-kind.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { parseAddMcpArgs } from "./connector-add-mcp-args.ts";

/** The gateway's `connector.userMcpCall` result, restated for the IPC boundary. */
export type UserMcpCallOutcome =
  | { status: "ok"; result: unknown }
  | { status: "rejected"; reason: string };

export interface UserMcpDeps {
  /**
   * `asPerson`: declare this connection as the owner's CLI first and answer consent only as a
   * person (a registration with a write directory; `--yes` and scripted consent become a decline).
   */
  call(method: string, params: unknown, opts?: { readonly asPerson?: boolean }): Promise<unknown>;
  log(line: string): void;
  error(line: string): void;
}

const TOOLS_USAGE = "Usage: nimbus connector tools <mcp_id|ext_id> [--json]";
const CALL_USAGE = "Usage: nimbus connector call <mcp_id|ext_id> <tool> [--input <json>] [--json]";

/** Gateway refusals that mean "nothing ran because of what you asked", not a failure. */
const REFUSAL_CODES = [
  "ERR_USER_MCP_UNKNOWN_TOOL",
  "ERR_USER_MCP_NOT_REGISTERED",
  // Every extension refusal: run-grant (RUN_*), grant-path (GRANT_*), entry, and a child that
  // failed to start (RUN_START_FAILED) — each means the call did not run.
  "ERR_EXTENSION_",
] as const;

function defaultDeps(): UserMcpDeps {
  return {
    // Default consent is the interactive prompt; `call` raises an I42 approval on this terminal.
    call: (method, params, opts) =>
      withGatewayIpc(
        async (c: IPCClient) => {
          if (opts?.asPerson === true) await declareCliClientKind(c);
          return c.call<unknown>(method, params);
        },
        undefined,
        {
          requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS,
          ...(opts?.asPerson === true ? { consent: { kind: "human" as const } } : {}),
        },
      ),
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
    // An MCP tool reports its own failure IN-BAND (`isError: true`). The gateway's MCP client
    // throws on one by default, so this arrives as an RPC error (exit 1 below); if one ever
    // reaches here as a result instead, it is still a failed call, never exit 0.
    const failed = isPlainObject(res.result) && res.result["isError"] === true;
    if (args.json) {
      d.log(JSON.stringify(res, null, 2));
    } else if (failed) {
      d.error(renderResult(res.result));
    } else {
      d.log(renderResult(res.result));
    }
    if (failed) process.exitCode = 1;
  } catch (e) {
    reportError(d, e);
  }
}

type AddMcpRejection = { status: "rejected"; reason?: string };

function isAddMcpRejection(r: unknown): r is AddMcpRejection {
  return typeof r === "object" && r !== null && (r as { status?: unknown }).status === "rejected";
}

/**
 * `nimbus connector add --mcp`. The gateway gates the registration on the owner's approval
 * (`connector.addMcp` is in the HITL frozen set), and a denied prompt comes back as a
 * `{ status: "rejected" }` RESULT, not an error — so it must be detected here, or a refused
 * registration would print "Registered" and every grant line and exit 0. Exit 2 matches
 * `connector call`'s refusal.
 */
export async function runConnectorAddMcp(
  tail: string[],
  deps?: UserMcpDeps,
  cwd: string = process.cwd(),
): Promise<void> {
  const d = deps ?? defaultDeps();
  const req = parseAddMcpArgs(tail, cwd);
  const wantsWrite = (req.writePaths?.length ?? 0) > 0;
  const r = await d.call("connector.addMcp", req, wantsWrite ? { asPerson: true } : undefined);
  if (isAddMcpRejection(r)) {
    d.log(`Refused: ${r.reason ?? "no reason given"}`);
    process.exitCode = 2;
    return;
  }
  const reply = isPlainObject(r) ? r : {};
  const serviceId = typeof reply["serviceId"] === "string" ? reply["serviceId"] : req.serviceId;
  // What was STORED, from the reply. A gateway from before write directories returns no grant
  // lists at all: the read and host lines then fall back to the request (as they always were), but
  // a write directory is never claimed on the strength of what was sent.
  const stored = (key: string): string[] | undefined => {
    const v = reply[key];
    return Array.isArray(v) && v.every((x): x is string => typeof x === "string") ? v : undefined;
  };
  const writePaths = stored("writePaths");
  if (wantsWrite && writePaths === undefined) {
    d.error(
      `This gateway does not support write directories; ${serviceId} was registered WITHOUT one. Remove it (nimbus connector remove ${serviceId}) or upgrade the gateway.`,
    );
    process.exitCode = 1;
    return;
  }
  d.log(`Registered user MCP connector: ${serviceId}`);
  for (const p of stored("readPaths") ?? req.readPaths) d.log(`  read: ${p}`);
  for (const h of stored("netHosts") ?? req.netHosts) d.log(`  net:  ${h}`);
  for (const w of writePaths ?? []) d.log(`  write: ${w}`);
  if ((writePaths?.length ?? 0) > 0) {
    d.log(
      "  The server's code can create and change files in the write directories. Nimbus checks them again every time the server starts.",
    );
  }
  const modelAccess =
    typeof reply["modelAccess"] === "boolean" ? reply["modelAccess"] : req.modelAccess;
  if (modelAccess) {
    d.log("  model: tools offered to the model in nimbus ask (each call still asks for approval)");
  }
}
