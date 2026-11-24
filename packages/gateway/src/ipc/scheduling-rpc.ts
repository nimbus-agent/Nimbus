import { lanLinkFor } from "../federation/lan-link.ts";
import { askPeerFreeBusy, type ScheduleAskResult } from "../federation/schedule-ask.ts";
import { scheduleConsent } from "../federation/schedule-consent-broker.ts";
import type { LocalIndex } from "../index/local-index.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { sendFederatedOverWire } from "./lan-client.ts";
import type { BoxKeypair } from "./lan-crypto.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `scheduling.*` (Phase 10, OR-S4-SCHED): the LOCAL owner's two entry points to federated
 * scheduling. `scheduling.ask` asks a paired peer for free/busy blocks and intersects them with the
 * owner's own; `scheduling.respond` answers the prompt for a peer's inbound request. Both serve only
 * a connection that DECLARED `cli` or `ui` (the kind is the CONNECTION's, never a param). The whole
 * namespace is LAN-forbidden (I5) and absent from the Tauri allowlist (I7): the answering side of
 * the wire is `federation.freeBusy`, served in `federation/federation-server.ts` through the gate.
 */
export class SchedulingRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "SchedulingRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface SchedulingRpcCtx {
  readonly index: LocalIndex;
  readonly selfIdentity: BoxKeypair | undefined;
  /** How long the answering owner has to approve (the asker waits this plus a margin). */
  readonly consentTimeoutMs: number;
  readonly callerKind: ClientKind;
  readonly now?: () => number;
  /** DI seam: replaces the real wire in tests. */
  readonly sendOverWire?: typeof sendFederatedOverWire;
}

const MIN_DURATION_MIN = 15;
const MAX_DURATION_MIN = 480;

function record(params: unknown): Record<string, unknown> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new SchedulingRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return params as Record<string, unknown>;
}

function requireOwner(kind: ClientKind): void {
  if (kind !== "cli" && kind !== "ui") {
    throw new SchedulingRpcError(
      -32000,
      "ERR_SCHEDULING_FORBIDDEN_CLIENT: scheduling is served only to a connection that declared cli or ui",
    );
  }
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new SchedulingRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be a non-empty string`);
  }
  return v;
}

async function ask(params: unknown, ctx: SchedulingRpcCtx): Promise<ScheduleAskResult> {
  requireOwner(ctx.callerKind);
  const rec = record(params);
  const peerId = str(rec, "peerId");
  const durationMin = rec["durationMin"];
  if (
    !Number.isSafeInteger(durationMin) ||
    (durationMin as number) < MIN_DURATION_MIN ||
    (durationMin as number) > MAX_DURATION_MIN
  ) {
    throw new SchedulingRpcError(
      -32602,
      `ERR_INVALID_PARAMS: durationMin must be a whole number from ${String(MIN_DURATION_MIN)} to ${String(MAX_DURATION_MIN)}`,
    );
  }
  if (ctx.selfIdentity === undefined) {
    throw new SchedulingRpcError(-32603, "ERR_FEDERATION_ASKER_UNAVAILABLE: identity not wired");
  }
  const row = ctx.index.listLanPeers().find((r) => r.peer_id === peerId);
  if (row === undefined) throw new SchedulingRpcError(-32602, `ERR_UNKNOWN_PEER: ${peerId}`);
  if (row.host_ip === null || row.host_port === null) {
    throw new SchedulingRpcError(-32602, `ERR_UNKNOWN_PEER: ${peerId} has no host address`);
  }
  const host = row.host_ip;
  const port = row.host_port;
  const self = ctx.selfIdentity;
  const send = ctx.sendOverWire ?? sendFederatedOverWire;
  return askPeerFreeBusy(
    {
      db: ctx.index.getDatabase(),
      ...(ctx.now === undefined ? {} : { now: ctx.now }),
      // The peer's owner may take the whole consent timeout (+ the broker's margin) to answer.
      send: (p) =>
        send(
          host,
          port,
          self,
          row.peer_pubkey,
          "federation.freeBusy",
          p,
          ctx.consentTimeoutMs + 15_000,
          lanLinkFor(row, ctx.index),
        ),
    },
    {
      fromMs: rec["fromMs"] as number,
      toMs: rec["toMs"] as number,
      durationMs: (durationMin as number) * 60_000,
    },
  );
}

function respond(params: unknown, ctx: SchedulingRpcCtx): { matched: boolean } {
  requireOwner(ctx.callerKind);
  const rec = record(params);
  const answerSource = typeof rec["answerSource"] === "string" ? rec["answerSource"] : undefined;
  const matched = scheduleConsent.respondFrom(str(rec, "requestId"), rec["approved"] === true, {
    kind: ctx.callerKind,
    answerSource,
  });
  return { matched };
}

export function dispatchSchedulingRpc(
  method: string,
  params: unknown,
  ctx: SchedulingRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<SchedulingRpcCtx>(method, params, ctx, {
    "scheduling.ask": ask,
    "scheduling.respond": respond,
  });
}
