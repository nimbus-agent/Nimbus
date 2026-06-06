import type { Database } from "bun:sqlite";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class TeamVaultRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "TeamVaultRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface TeamVaultRpcContext {
  readonly db: Database;
  readonly vault: {
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** Operator identity recorded as created_by. */
  readonly operator: string;
}

function rec(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== "object") {
    throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return p as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a non-empty string`);
  }
  return v;
}

export async function dispatchTeamVaultRpc(
  method: string,
  params: unknown,
  ctx: TeamVaultRpcContext,
): Promise<RpcMissOrHit> {
  const store = new TeamVaultStore(ctx.db);
  return dispatchByMethod<TeamVaultRpcContext>(method, params, ctx, {
    "teamvault.put": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const service = str(r, "service");
      const secrets = r["secrets"];
      if (secrets === null || typeof secrets !== "object") {
        throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: secrets object required");
      }
      for (const [k, v] of Object.entries(secrets as Record<string, unknown>)) {
        if (typeof v !== "string") {
          throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: secret ${k} must be a string`);
        }
        await ctx.vault.set(teamVaultKey(entry, k), v);
      }
      store.createEntry(entry, service, ctx.operator);
      return { ok: true };
    },
    "teamvault.delete": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const keys = r["keys"];
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (typeof k === "string") await ctx.vault.delete(teamVaultKey(entry, k));
        }
      }
      return { ok: true };
    },
    "teamvault.grant": (p) => {
      const r = rec(p);
      store.grant(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.revoke": (p) => {
      const r = rec(p);
      store.revoke(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.list": () => {
      return { entries: store.listEntries() };
    },
  });
}
