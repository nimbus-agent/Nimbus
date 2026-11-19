import type { Database } from "bun:sqlite";

import { renderPrereview } from "../agents/_lib/prreview-render.ts";
import type { PrereviewBrief } from "../agents/_lib/prreview-types.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { type SynthesisProvenance, synthesize } from "../agents/_lib/synthesize.ts";
import { buildPrereviewBrief, PrereviewError } from "../prreview/prreview-build.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { isOwnerKind } from "./incident-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `prreview.run` (Phase 10 "Automated PR pre-review"):
 *
 *   prreview.run { url, synthesize? } -> { markdown, brief, synthesis }
 *
 * Served only to a connection whose DECLARED kind is `cli` or `ui` (checked first, before any query): the brief
 * quotes the owner's own past review text. The `prreview` namespace is LAN-forbidden (I5, `ipc/lan-rpc.ts`) and
 * not renderer-callable (I7). A model is reached only when the request says `synthesize: true`, through the
 * existing `synthesize()` (I11 envelope, I31 re-attach of `## Gaps`, I29 for a remote model); otherwise no runner
 * is built and the answer is the deterministic render.
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
  /** Builds the synthesis runner for `agents.pr_prereview`; `undefined` when no model can be used. */
  readonly runner: () => SynthesisRunner | undefined;
}

export type PrereviewCaller = { readonly kind: ClientKind };

export type PrereviewResult = {
  readonly markdown: string;
  readonly brief: PrereviewBrief;
  /** null when no model was asked for. */
  readonly synthesis: SynthesisProvenance | null;
};

const URL_MAX = 2_048;
const ALLOWED_KEYS = ["url", "synthesize"] as const;

function paramsOf(raw: unknown): { url: string; synthesize: boolean } {
  const m = "prreview.run";
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PrereviewRpcError(-32602, `${m} requires an object payload`);
  }
  const p = raw as Record<string, unknown>;
  for (const key of Object.keys(p)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new PrereviewRpcError(-32602, `${m}: unknown parameter "${key}"`);
    }
  }
  const url = p["url"];
  if (typeof url !== "string" || url.trim() === "" || url.length > URL_MAX) {
    throw new PrereviewRpcError(-32602, `${m}: url must be a non-empty string`);
  }
  const want = p["synthesize"];
  if (want !== undefined && typeof want !== "boolean") {
    throw new PrereviewRpcError(-32602, `${m}: synthesize must be a boolean`);
  }
  return { url: url.trim(), synthesize: want === true };
}

async function run(ctx: PrereviewRpcCtx, raw: unknown): Promise<PrereviewResult> {
  const { url, synthesize: wantModel } = paramsOf(raw);
  let brief: PrereviewBrief;
  try {
    brief = buildPrereviewBrief(ctx.db, url, ctx.now());
  } catch (e) {
    if (e instanceof PrereviewError) throw new PrereviewRpcError(-32602, e.message);
    throw e;
  }
  if (!wantModel) {
    return { markdown: `${renderPrereview(brief)}\n`, brief, synthesis: null };
  }
  const runner = ctx.runner();
  if (runner === undefined) {
    return {
      markdown: `${renderPrereview(brief)}\n`,
      brief,
      synthesis: { attempted: false, reason: "disabled" },
    };
  }
  const out = await synthesize(brief, { runner });
  return { markdown: out.markdown, brief, synthesis: out.provenance };
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
