// `catalog.list` — the catalog an owner browses (`nimbus catalog`): the built-in agents with
// whether each is currently visible, then every connector on this install.
//
// Presentation only: nothing reads the result to gate a call, and hiding an agent never refuses
// one. CLI-callable today, LAN-forbidden (`ipc/lan-rpc.ts`), and NOT on the Tauri allowlist until
// the desktop adopts it.

import type { Database } from "bun:sqlite";
import { buildCatalogList, type CatalogListResult } from "../catalog/catalog-list.ts";
import { getLayeredConfig } from "../config/layered-config.ts";
import { connectorSignInKind } from "./connector-rpc-handlers/auth.ts";

export class CatalogRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CatalogRpcError";
  }
}

export type CatalogRpcContext = {
  readonly db: Database;
  readonly configDir: string;
  /** The active packs' suggested connectors (`activePackSuggestedConnectors`); absent = none. */
  readonly packSuggestions?: () => readonly string[];
};

function isEmptyParams(params: unknown): boolean {
  if (params === undefined || params === null) return true;
  if (typeof params !== "object" || Array.isArray(params)) return false;
  return Object.keys(params).length === 0;
}

export function dispatchCatalogRpc(
  method: string,
  params: unknown,
  ctx: CatalogRpcContext,
): { kind: "hit"; value: CatalogListResult } | { kind: "skip" } {
  if (method !== "catalog.list") return { kind: "skip" };
  if (!isEmptyParams(params)) {
    throw new CatalogRpcError(-32602, "catalog.list takes no params");
  }
  const reader = getLayeredConfig(ctx.configDir);
  return {
    kind: "hit",
    value: buildCatalogList({
      db: ctx.db,
      snapshot: () => reader.snapshot(),
      signInFor: connectorSignInKind,
      packSuggestions: ctx.packSuggestions?.() ?? [],
    }),
  };
}
