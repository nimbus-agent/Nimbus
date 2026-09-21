import type { Database } from "bun:sqlite";
import type { ListenerRegistry } from "../locality/listener-registry.ts";
import { buildLocalityReport, type LocalityReport } from "../locality/locality-report.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class LocalityRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "LocalityRpcError";
  }
}

export type LocalityRpcContext = {
  readonly db: Database;
  /**
   * `undefined` means this gateway was never wired with the path it opened its own database
   * from — an unwired gateway must fail loudly here rather than print a fabricated
   * `{ path: ":memory:", bytes: 0 }`, which would be a false statement on the locality panel.
   */
  readonly dbPath: string | undefined;
  readonly registry: ListenerRegistry;
  readonly nowMs: number;
};

function requireDbPath(dbPath: string | undefined): string {
  if (dbPath === undefined) {
    throw new LocalityRpcError(-32603, "locality.report requires a configured database path");
  }
  return dbPath;
}

function handleLocalityReport(_params: unknown, ctx: LocalityRpcContext): LocalityReport {
  const dbPath = requireDbPath(ctx.dbPath);
  return buildLocalityReport({
    db: ctx.db,
    dbPath,
    registry: ctx.registry,
    nowMs: ctx.nowMs,
  });
}

export async function dispatchLocalityRpc(
  method: string,
  params: unknown,
  ctx: LocalityRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "locality.report": handleLocalityReport });
}
