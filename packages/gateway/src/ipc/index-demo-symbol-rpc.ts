import type { Database } from "bun:sqlite";

import { type DemoSymbol, pickDemoSymbol } from "../agents/_lib/demo-symbol.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class IndexDemoSymbolRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IndexDemoSymbolRpcError";
  }
}

export type IndexDemoSymbolRpcContext = {
  db: Database;
};

function requireRepoRoot(params: unknown): string {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new IndexDemoSymbolRpcError(-32602, "index.demoSymbol requires an object of parameters");
  }
  const raw = (params as Record<string, unknown>)["repoRoot"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new IndexDemoSymbolRpcError(-32602, "index.demoSymbol requires a non-empty repoRoot");
  }
  return raw;
}

/**
 * Read-only: return one indexed symbol under `repoRoot`, or null.
 *
 * Exists so `nimbus init` can print a next command that points at a real
 * `file:line` from the user's own repository instead of a `<file>:<line>`
 * placeholder. The CLI cannot import gateway source (IPC-only boundary), so
 * reaching `pickDemoSymbol` needs this method.
 *
 * Deliberately NOT on the Tauri renderer allowlist (I7): it is a CLI
 * onboarding affordance with no renderer consumer, and the allowlist is
 * minimum-necessary — only `index.metrics` is exposed from `index.*` today.
 * Also FORBIDDEN_OVER_LAN for the same reason (I5 defense-in-depth): a paired
 * peer has no use for this machine's onboarding hint.
 */
function handleDemoSymbol(params: unknown, ctx: IndexDemoSymbolRpcContext): DemoSymbol | null {
  return pickDemoSymbol(ctx.db, requireRepoRoot(params));
}

export async function dispatchIndexDemoSymbolRpc(
  method: string,
  params: unknown,
  ctx: IndexDemoSymbolRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "index.demoSymbol": handleDemoSymbol });
}
