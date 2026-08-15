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
  register: (reg: ZodToolRegistrar) => void,
  options?: BuildReadOnlyMcpConnectorOptions,
): unknown {
  const make = options?.createServer ?? ((info) => new McpServer(info));
  const mcp = make({ name: serverName, version: "0.1.0" });
  const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));
  register(reg);
  return mcp;
}

export async function runReadOnlyMcpConnector(
  serverName: string,
  register: (reg: ZodToolRegistrar) => void,
  options?: RunReadOnlyMcpConnectorOptions,
): Promise<void> {
  const mcp = buildReadOnlyMcpConnector(serverName, register, options) as McpServer;
  const makeTransport = options?.createTransport ?? ((): unknown => new StdioServerTransport());
  await mcp.connect(makeTransport() as StdioServerTransport);
}
