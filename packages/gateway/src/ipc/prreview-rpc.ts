import type { Database } from "bun:sqlite";

import { renderPrereview } from "../agents/_lib/prreview-render.ts";
import type { PrereviewBrief } from "../agents/_lib/prreview-types.ts";
import { buildPrereviewBrief, PrereviewError } from "../prreview/prreview-build.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { isOwnerKind } from "./incident-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `prreview.run` (Phase 10 "Automated PR pre-review"):
 *
 *   prreview.run { url } -> { markdown, brief }
 *
 * Served only to a connection whose DECLARED kind is `cli` or `ui` (checked first, before any query): the brief
 * quotes the owner's own past review text. The `prreview` namespace is LAN-forbidden (I5, `ipc/lan-rpc.ts`) and
 * not renderer-callable (I7: absent from the Tauri allowlist). No model is reached: the answer is the
 * deterministic render of a read-only brief (no runner, no synthesis, no egress).
 */

export class PrereviewRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "PrereviewRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface PrereviewRpcCtx {
  readonly db: Database;
  readonly now: () => number;
}

export type PrereviewCaller = { readonly kind: ClientKind };

export type PrereviewResult = {
  readonly markdown: string;
  readonly brief: PrereviewBrief;
};

const URL_MAX = 2_048;

function urlOf(raw: unknown): string {
  const m = "prreview.run";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PrereviewRpcError(-32602, `${m} requires an object payload`);
  }
  const p = raw as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (key !== "url") throw new PrereviewRpcError(-32602, `${m}: unknown parameter "${key}"`);
  }
  const url = p["url"];
  if (typeof url !== "string" || url.trim() === "" || url.length > URL_MAX) {
    throw new PrereviewRpcError(-32602, `${m}: url must be a non-empty string`);
  }
  return url.trim();
}

function run(ctx: PrereviewRpcCtx, raw: unknown): PrereviewResult {
  const url = urlOf(raw);
  try {
    const brief = buildPrereviewBrief(ctx.db, url, ctx.now());
    return { markdown: `${renderPrereview(brief)}\n`, brief };
  } catch (e) {
    if (e instanceof PrereviewError) throw new PrereviewRpcError(-32602, e.message);
    throw e;
  }
}

export async function dispatchPrereviewRpc(
  method: string,
  params: unknown,
  ctx: PrereviewRpcCtx,
  caller: PrereviewCaller,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<PrereviewRpcCtx, unknown>(method, params, ctx, {
    "prreview.run": (raw) => {
      if (!isOwnerKind(caller.kind)) {
        throw new PrereviewRpcError(
          -32000,
          "ERR_PREREVIEW_FORBIDDEN_CLIENT: a pre-review is served only to the owner's own surfaces (the CLI and the desktop), on a connection that declared its kind",
        );
      }
      return run(ctx, raw);
    },
  });
}
