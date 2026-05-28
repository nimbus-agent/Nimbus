import type { ProfileManager } from "../config/profiles.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class ProfileRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "ProfileRpcError";
    this.rpcCode = rpcCode;
  }
}

export type ProfileRpcContext = {
  manager: ProfileManager;
  notify?: (method: string, params: unknown) => void;
};

function requireName(params: unknown, action: string): string {
  const p = params as { name?: unknown } | null;
  if (p === null || typeof p.name !== "string") {
    throw new ProfileRpcError(-32602, `${action} requires name`);
  }
  return p.name;
}

async function handleProfileList(_p: unknown, ctx: ProfileRpcContext): Promise<unknown> {
  const profiles = await ctx.manager.list();
  const active = (await ctx.manager.getActive()) ?? null;
  return { profiles, active };
}

async function handleProfileCreate(params: unknown, ctx: ProfileRpcContext): Promise<unknown> {
  const name = requireName(params, "profile.create");
  await ctx.manager.create(name);
  return { name };
}

async function handleProfileSwitch(params: unknown, ctx: ProfileRpcContext): Promise<unknown> {
  const name = requireName(params, "profile.switch");
  await ctx.manager.switchTo(name);
  ctx.notify?.("profile.switched", { name });
  return { active: name };
}

async function handleProfileDelete(params: unknown, ctx: ProfileRpcContext): Promise<unknown> {
  const name = requireName(params, "profile.delete");
  await ctx.manager.delete(name);
  return { deleted: name };
}

export async function dispatchProfileRpc(
  method: string,
  params: unknown,
  ctx: ProfileRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<ProfileRpcContext>(method, params, ctx, {
    "profile.list": handleProfileList,
    "profile.create": handleProfileCreate,
    "profile.switch": handleProfileSwitch,
    "profile.delete": handleProfileDelete,
  });
}
