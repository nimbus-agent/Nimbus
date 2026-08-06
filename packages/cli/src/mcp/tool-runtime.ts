// packages/cli/src/mcp/tool-runtime.ts

/**
 * The one construction site for an MCP `ToolResult`, and the one wrapper that turns a failure into
 * one.
 *
 * Lives apart from `adapter.ts` for the same reason `errors.ts` and `client-surface.ts` do:
 * `adapter.ts` imports `AGENT_TOOL_SPECS` (a runtime value) from `agent-tools.ts`, so anything
 * `agent-tools.ts` needs at runtime cannot come back out of `adapter.ts`. That extraction stopped
 * one file short and left `runAgentTool` re-implementing the error envelope inline four times —
 * two independent construction sites for the same shape, only one of them behind `runTool`'s tests.
 *
 * This module imports only `errors.ts` and `client-surface.ts`, so no cycle is possible.
 */

import type { z } from "zod";
import type { IpcCallable } from "./client-surface.ts";
import { GATEWAY_DOWN_MESSAGE, GatewayUnavailableError, isDisconnectError } from "./errors.ts";

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface AdapterDeps {
  /** Returns a connected client, reusing a cached connection while it is healthy. */
  getClient(): Promise<IpcCallable>;
  /**
   * Why the agent-classified tools cannot be served on the current connection, or `undefined` when
   * they can. Set when the gateway rejected `session.declareKind` as an unsupported method: such a
   * gateway still serves briefs but cannot attribute them, so nothing reaches the egress ledger and
   * `nimbus prove` reports a clean scope over unrecorded output.
   *
   * Optional so every test fake and every `ConnectionEnv`-built deps object stays valid without a
   * stub; absent means "no known reason", which is the correct reading for a hand-built deps.
   */
  agentToolsDisabledReason?(): string | undefined;
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  run(deps: AdapterDeps, args: Record<string, unknown>): Promise<ToolResult>;
}

/** Shown when an agent-classified tool is reached on a gateway that cannot attribute its output. */
export const AGENT_TOOLS_UNSUPPORTED_MESSAGE =
  "Nimbus: this gateway is too old to record MCP-served agent briefs in the egress ledger " +
  "(it rejects session.declareKind), so the agent tools are disabled rather than served " +
  "unrecorded — `nimbus prove` would otherwise report a clean scope over output it never saw. " +
  "Fix: upgrade the Nimbus gateway (`nimbus update`, then `nimbus restart`) and restart this MCP " +
  "client. The read-only index tools are unaffected and remain available.";

export function jsonResult(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Obtain a client and run `fn`, converting all failures into MCP error results (never a throw). */
export async function runTool(
  deps: AdapterDeps,
  fn: (c: IpcCallable) => Promise<ToolResult>,
): Promise<ToolResult> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch (e) {
    if (e instanceof GatewayUnavailableError) {
      return errorResult(e.message);
    }
    return errorResult(`Nimbus: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    return await fn(client);
  } catch (e) {
    if (isDisconnectError(e)) {
      return errorResult(GATEWAY_DOWN_MESSAGE);
    }
    return errorResult(`Nimbus: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * `runTool` plus the degraded-gateway refusal every agent-classified tool shares.
 *
 * The refusal is checked AFTER `getClient()` (inside `runTool`'s callback) on purpose: the reason
 * is only knowable once a connection has been opened and `session.declareKind` attempted, and a
 * gateway that is merely DOWN must still report "gateway is not running", not "upgrade it".
 *
 * This is the second half of the fail-closed behaviour. The first half is registration — a server
 * built against a gateway already known to be too old never lists these tools at all
 * (`buildMcpServer`). This path covers the case registration cannot: a gateway that was fine when
 * the server started and was replaced by an older one on a later reconnect.
 */
export async function runAgentClassifiedTool(
  deps: AdapterDeps,
  fn: (c: IpcCallable) => Promise<ToolResult>,
): Promise<ToolResult> {
  return await runTool(deps, async (c) => {
    const blocked = deps.agentToolsDisabledReason?.();
    return blocked === undefined ? await fn(c) : errorResult(blocked);
  });
}
