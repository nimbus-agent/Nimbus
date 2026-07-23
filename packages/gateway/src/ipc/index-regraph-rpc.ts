import type { Database } from "bun:sqlite";
import type { Logger } from "pino";

import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { type RegraphResult, regraphAllItems } from "../graph/regraph.ts";
import { buildServiceIdentityResolver } from "../metrics/service-identity.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class IndexRegraphRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "IndexRegraphRpcError";
  }
}

export type IndexRegraphRpcContext = {
  db: Database;
  configDir?: string;
  logger: Logger;
};

function requireNoParams(params: unknown): void {
  if (
    params !== null &&
    params !== undefined &&
    (typeof params !== "object" || Array.isArray(params) || Object.keys(params).length > 0)
  ) {
    throw new IndexRegraphRpcError(-32602, "index.regraph takes no parameters");
  }
}

async function handleRegraph(params: unknown, ctx: IndexRegraphRpcContext): Promise<RegraphResult> {
  requireNoParams(params);
  // Without the resolver, resolver-bound deployments/incidents re-sync with a
  // null affectedService and the retirement clears DESTROY their
  // correlates_with edges (1a Task 9 / the F1 fix). Fail toward preserving
  // edges: always thread the resolver when a configDir exists.
  const resolveServiceId =
    ctx.configDir === undefined
      ? undefined
      : buildServiceIdentityResolver(loadNimbusServiceConfigsFromConfigDir(ctx.configDir), (w) =>
          ctx.logger.warn({ warning: w }, "ambiguous service binding during regraph"),
        );
  return regraphAllItems(ctx.db, {
    logger: ctx.logger,
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  });
}

export async function dispatchIndexRegraphRpc(
  method: string,
  params: unknown,
  ctx: IndexRegraphRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, { "index.regraph": handleRegraph });
}
