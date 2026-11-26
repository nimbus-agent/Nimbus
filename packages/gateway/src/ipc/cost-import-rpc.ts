import type { Database } from "bun:sqlite";

import {
  CostImportError,
  type ImportReport,
  importFocusPath,
  removeCostImport,
} from "../finops/cost-import.ts";
import type { FocusProvider } from "../finops/focus-csv.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `cost.import` and `cost.importRemove` (Phase 7, the Cost Pack): the owner's FOCUS CSV import and the removal
 * of one import. Both read or delete the owner's own local data, and `cost.import` reads a local PATH, so both
 * serve only a connection that DECLARED the `cli` kind (`ctx.getClientKind`, never a param): not the renderer,
 * not an MCP client, not an agent. The whole `cost` namespace is LAN-forbidden (I5) and neither is
 * renderer-callable (I7). A demo-rooted gateway refuses both (I41: the demo index is the synthetic corpus).
 */
export class CostImportRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CostImportRpcCtx {
  readonly db: Database;
  readonly caller?: { readonly kind: ClientKind };
  readonly demo?: boolean;
  readonly now?: () => number;
}

const PROVIDERS: readonly FocusProvider[] = ["aws", "azure", "gcp"];

function requireCliOwner(ctx: CostImportRpcCtx, method: string): void {
  if (ctx.caller?.kind !== "cli") {
    throw new CostImportRpcError(
      -32000,
      `ERR_COST_FORBIDDEN_CLIENT: ${method} is served only to the owner's terminal, on a connection that declared the cli kind`,
    );
  }
  if (ctx.demo === true) {
    throw new CostImportRpcError(
      -32000,
      `ERR_COST_DEMO: ${method} is not available on the demo gateway`,
    );
  }
}

function objectParams(
  params: unknown,
  method: string,
  allowed: readonly string[],
): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new CostImportRpcError(-32602, `${method} requires an object payload`);
  }
  const p = params as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!allowed.includes(key))
      throw new CostImportRpcError(-32602, `${method}: unknown parameter "${key}"`);
  }
  return p;
}

export function handleCostImport(params: unknown, ctx: CostImportRpcCtx): ImportReport {
  requireCliOwner(ctx, "cost.import");
  const p = objectParams(params, "cost.import", ["path", "provider", "dryRun"]);
  const path = p["path"];
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw new CostImportRpcError(-32602, "cost.import: path must be a non-empty absolute path");
  }
  const provider = p["provider"];
  if (provider !== undefined && !PROVIDERS.includes(provider as FocusProvider)) {
    throw new CostImportRpcError(
      -32602,
      `cost.import: provider must be one of ${PROVIDERS.join(", ")}`,
    );
  }
  const dryRun = p["dryRun"] ?? false;
  if (typeof dryRun !== "boolean")
    throw new CostImportRpcError(-32602, "cost.import: dryRun must be a boolean");
  try {
    return importFocusPath(ctx.db, path, {
      dryRun,
      now: ctx.now ?? Date.now,
      ...(provider === undefined ? {} : { provider: provider as FocusProvider }),
    });
  } catch (e) {
    if (e instanceof CostImportError)
      throw new CostImportRpcError(-32000, `ERR_COST_IMPORT: ${e.message}`);
    throw e;
  }
}

export function handleCostImportRemove(
  params: unknown,
  ctx: CostImportRpcCtx,
): { importId: string; removed: number } {
  requireCliOwner(ctx, "cost.importRemove");
  const p = objectParams(params, "cost.importRemove", ["importId"]);
  const importId = p["importId"];
  if (typeof importId !== "string") {
    throw new CostImportRpcError(-32602, "cost.importRemove: importId must be a string");
  }
  try {
    return removeCostImport(ctx.db, importId);
  } catch (e) {
    if (e instanceof CostImportError)
      throw new CostImportRpcError(-32602, `cost.importRemove: ${e.message}`);
    throw e;
  }
}
