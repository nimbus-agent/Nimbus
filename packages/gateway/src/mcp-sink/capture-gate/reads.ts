import { expireDueActionsAudited } from "../capture-act.ts";
import { CAPTURE_ROLE_BY_KIND } from "../capture-client-policy.ts";
import { captureNativeStatus } from "../capture-native.ts";
import type { CaptureListOrder } from "../capture-store.ts";
import {
  type ActionPayload,
  CaptureError,
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
} from "../capture-types.ts";
import type {
  ActionProposalRow,
  CaptureCaller,
  CaptureDetail,
  CaptureGateDeps,
  CaptureMineView,
  CaptureStateView,
  CaptureStatus,
  CaptureSummary,
} from "./contract.ts";
import { HOUR_MS } from "./contract.ts";
import { asRecord, requireId, requireOwner, summarize } from "./shared.ts";

const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;
const MINE_LIMIT = 50;
const PROPOSALS_LIMIT = 200;

// ---- owner reads ---------------------------------------------------------------------------------

export function listCaptures(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  paramsRaw: unknown,
): { captures: CaptureSummary[] } {
  requireOwner(caller);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const p = paramsRaw === undefined ? {} : asRecord(paramsRaw);
  const state = p["state"];
  const kind = p["kind"];
  const order = p["order"];
  const limit = p["limit"] ?? LIST_LIMIT_DEFAULT;
  if (state !== undefined && !isCaptureState(state))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown state");
  if (kind !== undefined && !isCaptureKind(kind))
    throw new CaptureError("ERR_CAPTURE_INVALID", "unknown kind");
  if (order !== undefined && order !== "asc" && order !== "desc")
    throw new CaptureError("ERR_CAPTURE_INVALID", "order must be asc or desc");
  if (
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > LIST_LIMIT_MAX
  ) {
    throw new CaptureError(
      "ERR_CAPTURE_INVALID",
      `limit must be an integer 1..${String(LIST_LIMIT_MAX)}`,
    );
  }
  const filter: {
    state?: CaptureState;
    kind?: CaptureKind;
    limit: number;
    order?: CaptureListOrder;
  } = { limit };
  if (state !== undefined) filter.state = state;
  if (kind !== undefined) filter.kind = kind;
  if (order !== undefined) filter.order = order;
  return { captures: deps.store.list(filter).map(summarize) };
}

export function getCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): CaptureDetail {
  requireOwner(caller);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  return {
    ...summarize(row),
    payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as unknown),
    payloadBytes: row.payloadBytes,
    itemId: row.itemId,
    nativeRef: row.nativeRef,
    nativeStatus:
      row.state === "accepted" && row.nativeRef !== null
        ? captureNativeStatus(deps.db, { id: row.id, kind: row.kind, nativeRef: row.nativeRef })
        : null,
    outcomeRef: row.outcomeRef,
    errorCode: row.errorCode,
  };
}

/** `capture.state` (spec § 10): the agent polls a capture whose id it holds — never its payload. */
export function captureStateFor(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): CaptureStateView {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      "capture.state is for MCP clients; the owner uses captures.get",
    );
  }
  const id = requireId(idRaw);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const row = deps.store.get(id);
  // Agent door AD2 (D-AD-11): a row another connection submitted answers exactly like an absent id,
  // so the answer is no oracle for another agent's ids.
  if (row === undefined || row.sessionId !== caller.clientId) {
    throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  }
  return {
    kind: row.kind,
    state: row.state,
    ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
    ...(row.outcomeRef === null ? {} : { outcomeRef: row.outcomeRef }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}

/** `capture.mine`: the asking connection's own captures, newest first. State only, never a payload. */
export function captureMine(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
): { captures: CaptureMineView[] } {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      "capture.mine is for MCP clients; the owner uses captures.list",
    );
  }
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const captures = deps.store.listBySession(caller.clientId, MINE_LIMIT).map(
    (row): CaptureMineView => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      createdAt: row.createdAt,
      ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
      ...(row.outcomeRef === null ? {} : { outcomeRef: row.outcomeRef }),
      ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    }),
  );
  return { captures };
}

/**
 * The owner's queue of waiting action proposals, oldest first (`approvals.list`). Raw strings: the
 * RPC layer escapes them once. A row whose payload does not parse is skipped, never thrown.
 */
export function listActionProposals(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
): { proposals: ActionProposalRow[] } {
  requireOwner(caller);
  expireDueActionsAudited(deps, deps.now(), caller.clientId);
  const rows = deps.store.list({
    state: "proposed",
    kind: "action",
    order: "asc",
    limit: PROPOSALS_LIMIT,
  });
  const proposals: ActionProposalRow[] = [];
  for (const row of rows) {
    const p = parseActionPayload(row);
    if (p === undefined || row.expiresAt === null) continue;
    proposals.push({
      id: row.id,
      actionType: p.actionType,
      summary: p.summary,
      clientLabel: row.clientLabel,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      labelSource: row.labelSource,
    });
  }
  return { proposals };
}

function parseActionPayload(row: CaptureRow): ActionPayload | undefined {
  if (row.payloadJson === null) return undefined;
  try {
    const p = JSON.parse(row.payloadJson) as Partial<ActionPayload>;
    return typeof p.actionType === "string" && typeof p.summary === "string"
      ? (p as ActionPayload)
      : undefined;
  } catch {
    return undefined;
  }
}

export async function captureStatus(deps: CaptureGateDeps): Promise<CaptureStatus> {
  const now = deps.now();
  expireDueActionsAudited(deps, now, "capture-status");
  const cap = deps.capability();
  const types = cap.actionEnabled ? ((await deps.listProposableActionTypes?.()) ?? []) : [];
  const base = {
    enabled: cap.enabled,
    kinds: cap.enabled ? cap.kinds : [],
    pending: deps.store.countPendingNative(),
    maxPending: cap.config.maxPending,
    maxPerHour: cap.config.maxPerHour,
    refusedSinceStart: deps.refusals.snapshot(),
    actionEnabled: cap.actionEnabled,
    proposableActionTypes: types.slice(0, 200),
    actionPending: deps.store.countPendingActions(now),
    actionExpiringWithinHour: deps.store.countPendingActionsExpiringBy(now, now + HOUR_MS),
    actionMaxPending: cap.config.actionMaxPending,
    actionTtlHours: cap.config.actionTtlHours,
  };
  return cap.enabled ? base : { ...base, disabledReason: cap.reason };
}
