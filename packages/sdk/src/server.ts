/**
 * NimbusExtensionServer — base class for all Nimbus MCP extension servers
 *
 * Usage:
 *   const server = new NimbusExtensionServer({ manifest, onAuth });
 *   server.registerTool("search", { description, inputSchema, handler });
 *   server.start();
 */

import type { ExtensionManifest } from "./types";

export interface ExtensionServerOptions<TClient> {
  manifest: ExtensionManifest;
  onAuth?: (ctx: { accessToken: string }) => TClient;
}

export interface ToolDefinition<TInput, TClient> {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: TInput, ctx: { client: TClient }) => Promise<unknown>;
}

export class NimbusExtensionServer<TClient = unknown> {
  private readonly _options: ExtensionServerOptions<TClient>;

  constructor(options: ExtensionServerOptions<TClient>) {
    this._options = options;
  }

  registerTool<TInput>(_name: string, _definition: ToolDefinition<TInput, TClient>): void {
    // Roadmap Q3: register tool with MCP server
  }

  start(): void {
    if (this._options.manifest.id.length === 0) {
      throw new Error("NimbusExtensionServer: manifest.id is required");
    }
  }
}
