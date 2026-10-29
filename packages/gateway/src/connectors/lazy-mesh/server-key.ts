/**
 * The MCP server name an extension slot registers under: `@mastra/mcp` keys tools `<it>_<tool>`.
 * Dependency-free on purpose: the eval runtime (extensions/eval) imports it without reaching
 * `@mastra/mcp`, the health store or the DB through `extension-slot.ts`.
 */
export function extensionServerKey(serviceId: string): string {
  return serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}
