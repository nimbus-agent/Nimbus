import type { PolicyState } from "../policy/types.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

/** Typed RPC error carrying a JSON-RPC code (mirrors the other `*-rpc.ts` modules). */
export class PolicyRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "PolicyRpcError";
  }
}

export interface PolicyRefetchResult {
  readonly applied: boolean;
  readonly reason?: string;
}

export interface PolicySignResult {
  readonly org: string;
  readonly version: number;
}

export interface PolicyPurgeResult {
  readonly jobId: string;
  readonly localDeleted: number;
}

/**
 * Dependency seam for the policy/admin/team-purge IPC namespace. The privileged operations
 * (`policy.sign`, `team.purge`) are injected so the dispatcher stays pure + unit-testable; the
 * fail-closed guard lives here AND in the injected impls (defense in depth).
 */
export interface PolicyRpcCtx {
  /** Current enforced-policy runtime state (read-only). */
  readonly showPolicy: () => PolicyState;
  /** Anchor-only: validate, sign, persist + apply org policy TOML. Throws when not an anchor. */
  readonly signPolicy: (input: { toml: string }) => PolicySignResult | Promise<PolicySignResult>;
  /** Manually pin an org policy anchor pubkey. */
  readonly trustPubkey: (input: { pubkey: string }) => void;
  /** Best-effort peer refresh: fetch → verify → apply. */
  readonly refetch: () => Promise<PolicyRefetchResult>;
  /** Operator/anchor-only: begin a GDPR purge for the bound user. Throws when not permitted. */
  readonly purge: (input: { externalId: string }) => PolicyPurgeResult | Promise<PolicyPurgeResult>;
  /** True for local operator-trusted calls (the local IPC socket is owner-trusted). */
  readonly isAnchor: boolean;
}

function requireString(params: unknown, key: string): string {
  const rec = params as Record<string, unknown> | null;
  const v = rec === null || typeof rec !== "object" ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new PolicyRpcError(-32602, `ERR_INVALID_PARAMS: ${key} (string) required`);
  }
  return v;
}

const HANDLERS: RpcMethodHandlerMap<PolicyRpcCtx> = {
  // Read-only: the current enforced-policy runtime state.
  "policy.show": (_params: unknown, ctx: PolicyRpcCtx): PolicyState => ctx.showPolicy(),
  // Read-only verify variant: surface the same state (signatureValid carries the verdict).
  "policy.verify": (_params: unknown, ctx: PolicyRpcCtx): PolicyState => ctx.showPolicy(),
  // Privileged (anchor-only). Fail-closed here BEFORE touching the injected signer.
  "policy.sign": async (params: unknown, ctx: PolicyRpcCtx): Promise<PolicySignResult> => {
    if (!ctx.isAnchor) {
      throw new PolicyRpcError(-32000, "ERR_NOT_ANCHOR: policy.sign requires the org anchor");
    }
    return ctx.signPolicy({ toml: requireString(params, "toml") });
  },
  "policy.trust": (params: unknown, ctx: PolicyRpcCtx): { ok: true } => {
    ctx.trustPubkey({ pubkey: requireString(params, "pubkey") });
    return { ok: true } as const;
  },
  "policy.refetch": (_params: unknown, ctx: PolicyRpcCtx): Promise<PolicyRefetchResult> =>
    ctx.refetch(),
  // Privileged (operator/anchor-only). Fail-closed here BEFORE touching the injected purge.
  "team.purge": async (params: unknown, ctx: PolicyRpcCtx): Promise<PolicyPurgeResult> => {
    if (!ctx.isAnchor) {
      throw new PolicyRpcError(-32000, "ERR_NOT_PERMITTED: team.purge requires the operator");
    }
    return ctx.purge({ externalId: requireString(params, "externalId") });
  },
} as const;

export function dispatchPolicyRpc(
  method: string,
  params: unknown,
  ctx: PolicyRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
