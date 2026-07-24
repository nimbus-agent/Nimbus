import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { addRegisteredRoot, canonicalizeRootPath } from "../index/registered-roots-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class FilesystemRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "FilesystemRpcError";
    this.rpcCode = rpcCode;
  }
}

export type FilesystemRpcContext = {
  configDir: string;
};

interface EnsureRootResult {
  readonly path: string;
  readonly added: boolean;
}

/**
 * Register a local git repository as a blame/index root. Local-only (LAN-forbidden,
 * see FORBIDDEN_OVER_LAN). The caller supplies a path; the destination is the
 * config-pinned `registered-roots.json`. Requires an existing directory with a
 * `.git` entry — this structurally rejects `C:\` / `/`. The registered root takes
 * effect on the next gateway start (assemble merges it into the syncable roots).
 */
function handleEnsureRoot(params: unknown, ctx: FilesystemRpcContext): EnsureRootResult {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new FilesystemRpcError(-32602, "params must be an object");
  }
  const raw = (params as Record<string, unknown>)["path"];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new FilesystemRpcError(-32602, "params.path is required");
  }
  const canonical = canonicalizeRootPath(raw);
  if (canonical === null) {
    throw new FilesystemRpcError(-32602, "path does not resolve");
  }
  if (!statSync(canonical).isDirectory()) {
    throw new FilesystemRpcError(-32602, "path is not a directory");
  }
  if (!existsSync(join(canonical, ".git"))) {
    throw new FilesystemRpcError(-32602, "not a git repository");
  }
  const added = addRegisteredRoot(ctx.configDir, canonical);
  return { path: canonical, added };
}

export async function dispatchFilesystemRpc(
  method: string,
  params: unknown,
  ctx: FilesystemRpcContext,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<FilesystemRpcContext>(method, params, ctx, {
    "filesystem.ensureRoot": handleEnsureRoot,
  });
}
