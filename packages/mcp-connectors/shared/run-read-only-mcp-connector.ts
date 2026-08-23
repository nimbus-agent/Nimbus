import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  type McpListResult,
  type ZodObjectSchema,
} from "./mcp-tool-kit.ts";

export type ZodToolRegistrar = <T>(
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

export interface BuildReadOnlyMcpConnectorOptions {
  readonly createServer?: (info: { readonly name: string; readonly version: string }) => unknown;
}

/**
 * `createTransport` mirrors the existing `createServer` seam. Without it the
 * stdio transport was constructed inline, so `runReadOnlyMcpConnector` — the
 * function every connector's entry point actually calls — could not be executed
 * from a test at all: it would have opened a real stdio transport on the test
 * process. That left the wiring between server and transport asserted nowhere.
 *
 * Production callers pass nothing and get the real `StdioServerTransport`.
 */
export interface RunReadOnlyMcpConnectorOptions extends BuildReadOnlyMcpConnectorOptions {
  readonly createTransport?: () => unknown;
}

export function buildReadOnlyMcpConnector(
  serverName: string,
  // The SERVER is passed to `register` as a second argument. Despite this helper's name, several
  // of its connectors expose write tools, and those need the real server to build a consent
  // registrar — the read-only registrar alone cannot reach capabilities, registerTool or logging.
  // Optional in the callback's own signature, so the many genuinely read-only connectors that
  // ignore it are unaffected.
  register: (reg: ZodToolRegistrar, server: unknown) => void,
  options?: BuildReadOnlyMcpConnectorOptions,
): unknown {
  const make = options?.createServer ?? ((info) => new McpServer(info));
  const mcp = make({ name: serverName, version: "0.1.0" });
  const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));
  register(reg, mcp);
  return mcp;
}

export async function runReadOnlyMcpConnector(
  serverName: string,
  register: (reg: ZodToolRegistrar, server: unknown) => void,
  options?: RunReadOnlyMcpConnectorOptions,
): Promise<void> {
  const mcp = buildReadOnlyMcpConnector(serverName, register, options) as McpServer;
  const makeTransport = options?.createTransport ?? ((): unknown => new StdioServerTransport());
  await mcp.connect(makeTransport() as StdioServerTransport);
}
