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

// The handlers are synchronous because `ProfileManager` is. `dispatchByMethod` awaits each one
// inside an async function, so a throw here still reaches the caller as a REJECTION.
function handleProfileList(_p: unknown, ctx: ProfileRpcContext): unknown {
  const profiles = ctx.manager.list();
  const active = ctx.manager.getActive() ?? null;
  return { profiles, active };
}

function handleProfileCreate(params: unknown, ctx: ProfileRpcContext): unknown {
  const name = requireName(params, "profile.create");
  ctx.manager.create(name);
  return { name };
}

function handleProfileSwitch(params: unknown, ctx: ProfileRpcContext): unknown {
  const name = requireName(params, "profile.switch");
  ctx.manager.switchTo(name);
  ctx.notify?.("profile.switched", { name });
  return { active: name };
}

function handleProfileDelete(params: unknown, ctx: ProfileRpcContext): unknown {
  const name = requireName(params, "profile.delete");
  ctx.manager.delete(name);
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
