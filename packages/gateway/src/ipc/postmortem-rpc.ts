import type { Database } from "bun:sqlite";

import {
  PostmortemTemplateError,
  parsePostmortemTemplate,
} from "../agents/_lib/incident-postmortem-render.ts";
import type { PostmortemTemplate } from "../agents/_lib/incident-postmortem-types.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import type { SynthesisProvenance } from "../agents/_lib/synthesize.ts";
import type { TribalKbConfig } from "../connectors/connector-writes/model-write-refusals.ts";
import type { PreviewCredentialResolver } from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { ExecutorPolicyDep } from "../engine/executor.ts";
import { buildOwnerPushExecutor } from "../engine/run-ask.ts";
import type { AuditSink, ConnectorDispatcher } from "../engine/types.ts";
import { IncidentError } from "../incident/assemble.ts";
import { PostmortemError } from "../incident/postmortem-brief.ts";
import { PUSH_BODY_MAX_BYTES } from "../postmortem/postmortem-convert.ts";
import { draftPostmortem } from "../postmortem/postmortem-draft.ts";
import { type PushTarget, pushPostmortem } from "../postmortem/postmortem-push.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { IncidentRpcError, requireOwnerKind } from "./incident-rpc.ts";
import { recordIdFor, requireKeys, stringParam } from "./incident-rpc-params.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.postmortem` and `incident.postmortemPush` (Phase 10 IC7a, spec § 5.7).
 *
 *   incident.postmortem { id, template?, synthesize? }
 *       -> { recordId, version, markdown, synthesis }        a read: the draft, written by the CLI
 *   incident.postmortemPush { id, target, parent?, space?, title?, markdown }
 *       -> { outcome, ... }                                  the owner's HITL-gated page create(s)
 *
 * BOTH serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, called first, before
 * any query). They live in the `incident` namespace, which is LAN-forbidden (I5) and not renderer-callable (I7).
 * `synthesize: true` is the only way a model is reached, only on this owner request, never unattended
 * (OR-10-8). The push builds its executor per call around THIS connection's consent channel (the owner's own
 * terminal answers) with no delegation (`buildOwnerPushExecutor`, static D39(e)).
 */

export interface PostmortemActWiring {
  readonly dispatcher: ConnectorDispatcher;
  readonly egressSink: EgressSink;
  readonly audit: AuditSink;
  readonly policyHitl: ExecutorPolicyDep;
  readonly previewCredentialFor?: PreviewCredentialResolver;
  /** The tribal KB destinations the refusals compare against. */
  readonly getTribalKbConfig: () => TribalKbConfig | undefined;
}

export interface PostmortemRpcCtx {
  readonly db: Database;
  readonly now: () => number;
  /** Builds the synthesis runner for `agents.incident_postmortem`; `undefined` when no model can be used. */
  readonly runner: () => SynthesisRunner | undefined;
  /** The push wiring; absent means a push is unavailable (fail closed). */
  readonly act?: PostmortemActWiring | undefined;
}

export type PostmortemCaller = { readonly clientId: string; readonly kind: ClientKind };

const TEMPLATE_PARAM_MAX = 80_000;
const MARKDOWN_PARAM_MAX = PUSH_BODY_MAX_BYTES + 1_024;
const NOTION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;
const SPACE_KEY_RE = /^[~A-Za-z0-9_-]{1,255}$/;
const CONFLUENCE_ID_RE = /^\d{1,20}$/;

function booleanParam(method: string, p: Record<string, unknown>, key: string): boolean {
  const v = p[key];
  if (v === undefined) return false;
  if (typeof v !== "boolean") {
    throw new IncidentRpcError(-32602, `${method}: ${key} must be a boolean`);
  }
  return v;
}

function domainError(e: unknown): never {
  if (e instanceof IncidentError || e instanceof PostmortemError) {
    throw new IncidentRpcError(-32602, `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}`);
  }
  if (e instanceof PostmortemTemplateError) throw new IncidentRpcError(-32602, e.message);
  throw e;
}

async function postmortem(ctx: PostmortemRpcCtx, raw: unknown): Promise<unknown> {
  const m = "incident.postmortem";
  const p = requireKeys(m, raw, ["id", "template", "synthesize"]);
  const recordId = recordIdFor(ctx.db, m, p);
  const templateText = stringParam(m, p, "template", TEMPLATE_PARAM_MAX);
  const wantModel = booleanParam(m, p, "synthesize");
  try {
    const template: PostmortemTemplate | null =
      templateText === undefined ? null : parsePostmortemTemplate(templateText);
    const runner = wantModel ? ctx.runner() : undefined;
    const draft = await draftPostmortem({
      db: ctx.db,
      nowMs: ctx.now(),
      recordId,
      template,
      runner,
    });
    const synthesis: SynthesisProvenance | null =
      wantModel && runner === undefined
        ? { attempted: false, reason: "disabled" }
        : draft.synthesis;
    return {
      recordId: draft.recordId,
      version: draft.version,
      markdown: draft.markdown,
      synthesis,
    };
  } catch (e) {
    return domainError(e);
  }
}

function targetOf(m: string, p: Record<string, unknown>): PushTarget {
  const target = stringParam(m, p, "target", 16);
  const parent = stringParam(m, p, "parent", 64);
  const space = stringParam(m, p, "space", 255);
  if (target === "notion") {
    if (space !== undefined || parent === undefined || !NOTION_ID_RE.test(parent)) {
      throw new IncidentRpcError(
        -32602,
        `${m}: notion needs parent, a page id (32 hex characters, hyphens allowed), and no space`,
      );
    }
    return { kind: "notion", parentPageId: parent };
  }
  if (target === "confluence") {
    if (space === undefined || !SPACE_KEY_RE.test(space)) {
      throw new IncidentRpcError(-32602, `${m}: confluence needs space, a space key`);
    }
    if (parent !== undefined && !CONFLUENCE_ID_RE.test(parent)) {
      throw new IncidentRpcError(-32602, `${m}: confluence parent must be a numeric page id`);
    }
    return {
      kind: "confluence",
      spaceKey: space,
      ...(parent === undefined ? {} : { parentPageId: parent }),
    };
  }
  throw new IncidentRpcError(-32602, `${m}: target must be notion or confluence`);
}

async function postmortemPush(
  ctx: PostmortemRpcCtx,
  raw: unknown,
  caller: PostmortemCaller,
  consent: ConsentCoordinator | undefined,
): Promise<unknown> {
  const m = "incident.postmortemPush";
  const p = requireKeys(m, raw, ["id", "target", "parent", "space", "title", "markdown"]);
  const recordId = recordIdFor(ctx.db, m, p);
  const target = targetOf(m, p);
  const title = stringParam(m, p, "title", 1_000);
  const markdown = stringParam(m, p, "markdown", MARKDOWN_PARAM_MAX);
  if (markdown === undefined) {
    throw new IncidentRpcError(-32602, `${m}: markdown must be a non-empty string`);
  }
  const act = ctx.act;
  if (act === undefined || consent === undefined) {
    throw new IncidentRpcError(
      -32000,
      "ERR_POSTMORTEM_PUSH_UNAVAILABLE: pushing a page is not available on this gateway",
    );
  }
  const executor = buildOwnerPushExecutor({
    clientId: caller.clientId,
    consentCoordinator: consent,
    audit: act.audit,
    dispatcher: act.dispatcher,
    egressSink: act.egressSink,
    policyHitl: act.policyHitl,
    ...(act.previewCredentialFor === undefined
      ? {}
      : { previewCredentialFor: act.previewCredentialFor }),
  });
  try {
    return await pushPostmortem(
      { db: ctx.db, executor, refusal: { chatops: undefined, kb: act.getTribalKbConfig() } },
      recordId,
      target,
      markdown,
      title,
    );
  } catch (e) {
    return domainError(e);
  }
}

export async function dispatchPostmortemRpc(
  method: string,
  params: unknown,
  ctx: PostmortemRpcCtx,
  caller: PostmortemCaller,
  consent?: ConsentCoordinator,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<PostmortemRpcCtx, unknown>(method, params, ctx, {
    "incident.postmortem": (raw) => {
      requireOwnerKind(caller.kind);
      return postmortem(ctx, raw);
    },
    "incident.postmortemPush": (raw) => {
      requireOwnerKind(caller.kind);
      return postmortemPush(ctx, raw, caller, consent);
    },
  });
}
