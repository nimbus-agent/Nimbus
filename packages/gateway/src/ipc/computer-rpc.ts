import type { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import type {
  CuActionConsentBroker,
  CuEnvelopeConsentBroker,
} from "../computer-use/cu-consent-broker.ts";
import {
  type CuGateDeps,
  closeSession,
  isCuActionKind,
  type OpenSessionRequest,
  openSession,
  type RunActionRequest,
  runAction,
} from "../computer-use/cu-gate.ts";
import { asRecord } from "../connectors/unknown-record.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

/** A `ComputerRpcError` carries the JSON-RPC error code surfaced by the dispatcher chain. */
export class ComputerRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ComputerRpcError";
  }
}

export interface ComputerRpcCtx {
  /** Everything `openSession`/`runAction`/`closeSession` need; assembled once at boot. */
  readonly gateDeps: CuGateDeps;
  /** The owner-approval brokers this surface answers into (I35). */
  readonly envelopeConsent: CuEnvelopeConsentBroker;
  readonly actionConsent: CuActionConsentBroker;
}

/**
 * Module-private, matching `exec-rpc.ts`.
 *
 * There is no shared IPC validation module: `requireString` is redefined across several files
 * under `ipc/`. Consolidating them is a worthwhile cleanup but would put most of this feature's
 * diff in unrelated RPC modules, so it is deliberately left alone here.
 */
function requireString(params: unknown, key: string): string {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ComputerRpcError(-32602, `ERR_INVALID_PARAMS: ${key} (non-empty string) required`);
  }
  return v;
}

/**
 * Every element must be a string; a non-array or a mixed array yields an EMPTY origin list, never
 * a partial one -- a half-parsed grant set is a grant the caller did not ask for, and silently
 * dropping the bad element would hand the session an origin allowlist nobody chose.
 */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
}

/**
 * Two lanes ship. `screen` is a `KNOWN_CU_LANES` member with no implementation, so it is rejected
 * HERE rather than allowed through to a gate that would refuse it less clearly — and rejected at
 * the TRANSPORT, because a TS type is erased by the time an externally-supplied value reaches this
 * module as `unknown`.
 */
function requireShippedLane(params: unknown): "browser" | "terminal" {
  const v = asRecord(params)?.["lane"];
  if (v !== "browser" && v !== "terminal") {
    throw new ComputerRpcError(-32602, 'ERR_INVALID_PARAMS: lane must be "browser" or "terminal"');
  }
  return v;
}

/**
 * Absolute-only, and REFUSED rather than resolved: the gateway's working directory is not the
 * caller's, so resolving here would grant a real directory nobody named. Mirrors `exec-policy.ts`'s
 * `requireAbsolute` and the CLI's own client-side resolution.
 */
function requireAbsolutePath(params: unknown, key: string): string {
  const v = requireString(params, key);
  if (!isAbsolute(v)) {
    throw new ComputerRpcError(-32602, `ERR_INVALID_PARAMS: ${key} must be an absolute path`);
  }
  return v;
}

interface CuSessionStatusEntry {
  readonly sessionId: string;
  readonly lane: string;
  readonly openedAt: number;
  readonly closedAt: number | null;
  readonly closeReason: string | null;
  readonly taintedAt: number | null;
  readonly actionsUsed: number;
  readonly open: boolean;
}

interface CuSessionRow {
  readonly id: string;
  readonly lane: string;
  readonly opened_at: number;
  readonly closed_at: number | null;
  readonly close_reason: string | null;
  readonly tainted_at: number | null;
  readonly actions_used: number;
}

function toStatusEntry(row: CuSessionRow): CuSessionStatusEntry {
  return {
    sessionId: row.id,
    lane: row.lane,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    taintedAt: row.tainted_at,
    actionsUsed: row.actions_used,
    open: row.closed_at === null,
  };
}

/**
 * Reads the durable `cu_session` replay-body row(s) (V57) -- a plain read, not a mutation, so no
 * owner-consent gate applies. A specific `sessionId` returns at most one entry, an empty list if
 * it does not exist (never a throw: "not found" is a normal answer for a status probe, matching
 * `closeSession`'s own `not_found` result rather than raising an error for it). Omitting the id
 * lists the most recently opened sessions, which is what `nimbus computer sessions` needs.
 */
function querySessionStatus(
  db: Database,
  sessionId: string | undefined,
): { sessions: CuSessionStatusEntry[] } {
  if (sessionId !== undefined) {
    const row = db
      .query(
        `SELECT id, lane, opened_at, closed_at, close_reason, tainted_at, actions_used
         FROM cu_session WHERE id = ?`,
      )
      .get(sessionId) as CuSessionRow | null;
    return { sessions: row === null ? [] : [toStatusEntry(row)] };
  }
  const rows = db
    .query(
      `SELECT id, lane, opened_at, closed_at, close_reason, tainted_at, actions_used
       FROM cu_session ORDER BY opened_at DESC LIMIT 50`,
    )
    .all() as CuSessionRow[];
  return { sessions: rows.map(toStatusEntry) };
}

const HANDLERS: RpcMethodHandlerMap<ComputerRpcCtx> = {
  // The I35 chokepoint's only transport. Everything crossing this boundary is `unknown` until
  // validated -- no casts on `params`.
  "computer.sessionOpen": (params, ctx) => {
    const lane = requireShippedLane(params);
    const rec = asRecord(params) ?? {};
    const bounds = {
      ...(typeof rec["maxActions"] === "number" ? { maxActions: rec["maxActions"] } : {}),
      ...(typeof rec["maxWallClockMs"] === "number"
        ? { maxWallClockMs: rec["maxWallClockMs"] }
        : {}),
    };
    const req: OpenSessionRequest =
      lane === "browser"
        ? {
            lane,
            navigateOrigins: stringArray(rec["navigateOrigins"]),
            scriptOrigins: stringArray(rec["scriptOrigins"]),
            ...bounds,
          }
        : {
            lane,
            // REQUIRED, never defaulted: defaulting would silently grant the gateway's own working
            // directory, which is not the caller's and is not anything the owner chose.
            cwd: requireAbsolutePath(params, "cwd"),
            ...(typeof rec["shellId"] === "string" ? { shellId: rec["shellId"] } : {}),
            ...bounds,
          };
    return openSession(req, ctx.gateDeps);
  },

  "computer.sessionClose": (params, ctx) => {
    const sessionId = requireString(params, "sessionId");
    return closeSession(sessionId, ctx.gateDeps);
  },

  "computer.act": (params, ctx) => {
    const sessionId = requireString(params, "sessionId");
    const rec = asRecord(params) ?? {};
    const kind = rec["kind"];
    // Validated with the EXPORTED runtime guard, BEFORE constructing a `RunActionRequest` and
    // before `runAction` is ever called -- an unrecognised kind must never consume a live
    // session's action budget.
    if (!isCuActionKind(kind)) {
      throw new ComputerRpcError(
        -32602,
        "ERR_INVALID_PARAMS: kind must be a recognised action kind",
      );
    }
    const req: RunActionRequest = {
      sessionId,
      kind,
      ...(typeof rec["selector"] === "string" ? { selector: rec["selector"] } : {}),
      ...(typeof rec["text"] === "string" ? { text: rec["text"] } : {}),
      ...(typeof rec["url"] === "string" ? { url: rec["url"] } : {}),
      ...(typeof rec["modelDescription"] === "string"
        ? { modelDescription: rec["modelDescription"] }
        : {}),
    };
    return runAction(req, ctx.gateDeps);
  },

  "computer.sessionStatus": (params, ctx) => {
    const raw = asRecord(params)?.["sessionId"];
    const sessionId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    return querySessionStatus(ctx.gateDeps.db, sessionId);
  },

  "computer.approvalRespond": (params, ctx) => {
    const requestId = requireString(params, "requestId");
    // Strict `=== true`: a missing or malformed field must read as denial, never approval.
    const approved = asRecord(params)?.["approved"] === true;
    // The caller does not say which broker a requestId belongs to (a session-open envelope prompt
    // and a per-action prompt share one `computer.approvalRespond` verb), so try both. Each broker
    // mints its own `randomUUID()`, so at most one of the two calls can ever match.
    const matchedEnvelope = ctx.envelopeConsent.respond(requestId, approved);
    const matchedAction = matchedEnvelope ? false : ctx.actionConsent.respond(requestId, approved);
    return { matched: matchedEnvelope || matchedAction };
  },
};

export function dispatchComputerRpc(
  method: string,
  params: unknown,
  ctx: ComputerRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
