import type { Database } from "bun:sqlite";
import { AnnotateError, type AnnotateOptions, annotateDeployment } from "../deployment/annotate.ts";
import type { DeploymentAnnotateInput, DeploymentAnnotateResult } from "../deployment/types.ts";

export class DeploymentRpcError extends Error {
  readonly rpcCode: number;
  readonly field: string | undefined;
  constructor(rpcCode: number, message: string, field?: string) {
    super(message);
    this.name = "DeploymentRpcError";
    this.rpcCode = rpcCode;
    this.field = field;
  }
}

export interface DeploymentRpcContext {
  readonly db: Database;
  readonly nowMs?: () => number;
  readonly deployEnvironments?: readonly string[];
}

function requireParams(params: unknown): DeploymentAnnotateInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new DeploymentRpcError(-32602, "deployment.annotate requires a JSON-object body");
  }
  return params as DeploymentAnnotateInput;
}

export async function dispatchDeploymentRpc(
  method: string,
  params: unknown,
  ctx: DeploymentRpcContext,
): Promise<{ kind: "miss" } | { kind: "hit"; value: DeploymentAnnotateResult }> {
  if (method !== "deployment.annotate") return { kind: "miss" };
  const input = requireParams(params);
  const nowMs = (ctx.nowMs ?? (() => Date.now()))();
  try {
    const opts: AnnotateOptions =
      ctx.deployEnvironments === undefined ? {} : { deployEnvironments: ctx.deployEnvironments };
    const value = annotateDeployment(ctx.db, input, nowMs, opts);
    return { kind: "hit", value };
  } catch (e) {
    if (e instanceof AnnotateError) {
      throw new DeploymentRpcError(-32602, `${e.field}: ${e.message}`, e.field);
    }
    throw e;
  }
}
