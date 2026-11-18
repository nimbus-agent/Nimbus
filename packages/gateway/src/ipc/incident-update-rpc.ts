import type { Database } from "bun:sqlite";

import { UPDATE_AUDIENCES, type UpdateAudience } from "../agents/_lib/incident-update-render.ts";
import type { PreviewCredentialResolver } from "../connectors/connector-writes/types.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { ExecutorPolicyDep } from "../engine/executor.ts";
import { buildOwnerPushExecutor } from "../engine/run-ask.ts";
import type { AuditSink, ConnectorDispatcher } from "../engine/types.ts";
import { IncidentError } from "../incident/assemble.ts";
import { listQueuedDrafts } from "../incident-update/scribe.ts";
import { draftIncidentUpdate } from "../incident-update/update-draft.ts";
import {
  sendIncidentUpdate,
  UPDATE_TEXT_MAX,
  type UpdateDestination,
} from "../incident-update/update-send.ts";
import type { ChatopsPolicy } from "../policy/types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { IncidentRpcError, requireOwnerKind } from "./incident-rpc.ts";
import { recordIdFor, requireKeys, stringParam } from "./incident-rpc-params.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.update`, `incident.updateSend` and `incident.updateQueue` (Phase 10 IC9b, spec § 5.9).
 *
 *   incident.update { id, audience?, version? }   -> { recordId, version, currentVersion, audience, text }   a read
 *   incident.updateSend { id, platform, channel? | teamId? + channelId?, text }  -> { outcome, ... }   HITL-gated
 *   incident.updateQueue {}                       -> { entries: [{ recordId, version, queuedAtMs }] }      a read
 *
 * ALL THREE serve only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, called first, before
 * any query). They live in the `incident` namespace, which is LAN-forbidden (I5), and are not renderer-callable
 * (I7). No model is reached. The send builds its executor per call around THIS connection's consent channel (the
 * owner's own terminal answers) with no delegation (`buildOwnerPushExecutor`, static D39(e)).
 */

export interface UpdateActWiring {
  readonly dispatcher: ConnectorDispatcher;
  readonly egressSink: EgressSink;
  readonly audit: AuditSink;
  readonly policyHitl: ExecutorPolicyDep;
  readonly previewCredentialFor?: PreviewCredentialResolver;
}

export interface IncidentUpdateRpcCtx {
  readonly db: Database;
  readonly now: () => number;
  /** Where the scribe keeps its queue; absent means the queue lists nothing. */
  readonly dataDir?: string | undefined;
  /** The ChatOps bindings of the LIVE enforced policy; absent or undefined refuses a send. */
  readonly chatops: () => ChatopsPolicy | undefined;
  /** The send wiring; absent means a send is unavailable (fail closed). */
  readonly act?: UpdateActWiring | undefined;
}

export type UpdateCaller = { readonly clientId: string; readonly kind: ClientKind };

// A channel (C) or private channel (G) id only: a DM (D) or user (U) id would post to a person (OR scope: no DM).
const SLACK_CHANNEL_RE = /^[CG][A-Z0-9]{1,31}$/;
const TEAMS_TEAM_RE = /^[0-9A-Za-z-]{1,64}$/;
const TEAMS_CHANNEL_RE = /^19:[^\s]{1,200}$/;

function domainError(e: unknown): never {
  if (e instanceof IncidentError) {
    throw new IncidentRpcError(-32602, `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}`);
  }
  throw e;
}

function audienceOf(m: string, p: Record<string, unknown>): UpdateAudience {
  const v = p["audience"];
  if (v === undefined) return "stakeholders";
  if (typeof v !== "string" || !(UPDATE_AUDIENCES as readonly string[]).includes(v)) {
    throw new IncidentRpcError(-32602, `${m}: audience must be stakeholders or engineers`);
  }
  return v as UpdateAudience;
}

function versionOf(m: string, p: Record<string, unknown>): number | undefined {
  const v = p["version"];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) {
    throw new IncidentRpcError(-32602, `${m}: version must be a positive integer`);
  }
  return v;
}

function update(ctx: IncidentUpdateRpcCtx, raw: unknown): unknown {
  const m = "incident.update";
  const p = requireKeys(m, raw, ["id", "audience", "version"]);
  const recordId = recordIdFor(ctx.db, m, p);
  const audience = audienceOf(m, p);
  const version = versionOf(m, p);
  try {
    return draftIncidentUpdate(ctx.db, recordId, {
      audience,
      nowMs: ctx.now(),
      ...(version === undefined ? {} : { version }),
    });
  } catch (e) {
    return domainError(e);
  }
}

function destinationOf(m: string, p: Record<string, unknown>): UpdateDestination {
  const platform = stringParam(m, p, "platform", 16);
  if (platform === "slack") {
    const channel = stringParam(m, p, "channel", 64);
    if (channel === undefined || !SLACK_CHANNEL_RE.test(channel) || p["teamId"] !== undefined) {
      throw new IncidentRpcError(
        -32602,
        `${m}: slack needs channel, a channel id such as C0123ABC, and no teamId`,
      );
    }
    return { platform, channel };
  }
  if (platform === "teams") {
    const teamId = stringParam(m, p, "teamId", 64);
    const channelId = stringParam(m, p, "channelId", 210);
    if (
      teamId === undefined ||
      channelId === undefined ||
      !TEAMS_TEAM_RE.test(teamId) ||
      !TEAMS_CHANNEL_RE.test(channelId) ||
      p["channel"] !== undefined
    ) {
      throw new IncidentRpcError(
        -32602,
        `${m}: teams needs teamId and channelId (a 19: thread id), and no channel`,
      );
    }
    return { platform, teamId, channelId };
  }
  throw new IncidentRpcError(-32602, `${m}: platform must be slack or teams`);
}

async function updateSend(
  ctx: IncidentUpdateRpcCtx,
  raw: unknown,
  caller: UpdateCaller,
  consent: ConsentCoordinator | undefined,
): Promise<unknown> {
  const m = "incident.updateSend";
  const p = requireKeys(m, raw, ["id", "platform", "channel", "teamId", "channelId", "text"]);
  const recordId = recordIdFor(ctx.db, m, p);
  const dest = destinationOf(m, p);
  const text = stringParam(m, p, "text", UPDATE_TEXT_MAX + 1);
  if (text === undefined)
    throw new IncidentRpcError(-32602, `${m}: text must be a non-empty string`);
  const act = ctx.act;
  if (act === undefined || consent === undefined) {
    throw new IncidentRpcError(
      -32000,
      "ERR_INCIDENT_UPDATE_UNAVAILABLE: sending an update is not available on this gateway",
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
    return await sendIncidentUpdate(
      { db: ctx.db, executor, chatops: ctx.chatops },
      recordId,
      dest,
      text,
    );
  } catch (e) {
    return domainError(e);
  }
}

function updateQueue(ctx: IncidentUpdateRpcCtx, raw: unknown): unknown {
  requireKeys("incident.updateQueue", raw ?? {}, []);
  if (ctx.dataDir === undefined) return { entries: [] };
  return { entries: listQueuedDrafts(ctx.db, ctx.dataDir) };
}

export async function dispatchIncidentUpdateRpc(
  method: string,
  params: unknown,
  ctx: IncidentUpdateRpcCtx,
  caller: UpdateCaller,
  consent?: ConsentCoordinator,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<IncidentUpdateRpcCtx, unknown>(method, params, ctx, {
    "incident.update": (raw) => {
      requireOwnerKind(caller.kind);
      return update(ctx, raw);
    },
    "incident.updateSend": (raw) => {
      requireOwnerKind(caller.kind);
      return updateSend(ctx, raw, caller, consent);
    },
    "incident.updateQueue": (raw) => {
      requireOwnerKind(caller.kind);
      return updateQueue(ctx, raw);
    },
  });
}
