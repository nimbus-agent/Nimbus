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
): Promise<void> {
  const mcp = buildReadOnlyMcpConnector(serverName, register) as McpServer;
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
