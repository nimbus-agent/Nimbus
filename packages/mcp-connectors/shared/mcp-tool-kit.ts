/**
 * mcp-tool-kit — re-export of the MCP connector helpers now owned by
 * `@nimbus-dev/sdk/connector-kit`.
 *
 * These helpers originated here and were upstreamed to the SDK in 1.11.0. The
 * SDK is now the single owner; this module stays as the connector-facing import
 * path so the ~99 connectors keep their existing relative imports.
 *
 * Named re-exports, deliberately not `export *`: a star would also re-export the
 * sibling kits' symbols (fetch-bearer-json, rest-tool-kit) through this path,
 * widening the surface each connector sees and making a two-module import
 * ambiguous. Keep this list matched to the symbols this file used to define.
 */

export type {
  HttpJsonBodyResponse,
  HttpTextResponse,
  McpListResult,
  RegisterSimpleToolFn,
  ZodObjectSchema,
} from "@nimbus-dev/sdk/connector-kit";
export {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  encodeBasicAuthHeader,
  fetchWithTimeout,
  mcpJsonResult,
  mcpJsonResultFromTextIfOk,
  mcpJsonResultIfOk,
  parseJsonTextIfOk,
  putOptionalBoolean,
  putOptionalNonEmptyString,
  registerZodTool,
  requireProcessEnv,
} from "@nimbus-dev/sdk/connector-kit";
