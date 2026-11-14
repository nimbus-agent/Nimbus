import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { PlannedAction } from "../engine/types.ts";
import { isCaptureId } from "../mcp-sink/capture-id.ts";
import type { EgressSourceType } from "./egress-source-type.ts";

/** Max body bytes for `payload_summary` before the redactor appends `…[truncated]`. */
const EGRESS_SUMMARY_MAX_BYTES = 256;

export type EgressResultStatus = "authorized" | "blocked";
export type EgressHitlStatus = "approved" | "not_required" | "rejected" | "standing_approved";

export interface EgressEntry {
  readonly timestamp: number;
  readonly sourceType: EgressSourceType;
  readonly sourceId: string | null;
  readonly destination: string;
  readonly method: string;
  readonly payloadSummary: string;
  readonly hitlStatus: EgressHitlStatus;
  readonly resultStatus: EgressResultStatus;
}

/**
 * The destination recorded in the ledger: the service/host PREFIX of the action type
 * (`serviceOf` — the segment before the first dot), never a raw URL. So no secret-bearing
 * query string is ever stored.
 */
export function summarizeDestination(actionType: string): string {
  return serviceOf(actionType);
}

/**
 * The redacted, length-capped payload summary. Reuses the shipped `redactAuditPayload` (strips
 * gh*_/sk-/Bearer/JWT/AWS families + token|key|secret|… object keys). Best-effort credential
 * scrubbing for debugging — NOT relied on as the security boundary (the security claim is the
 * append-before-dispatch chokepoint, not the redactor).
 */
export function redactEgressSummary(payload: unknown): string {
  return redactAuditPayload(payload ?? {}, EGRESS_SUMMARY_MAX_BYTES);
}

/**
 * The `source_id` prefix of an outside agent's action (AD4): `agent:<captureId>`. Written only here
 * and read only by `audit/agent-door-proof.ts` (a source pin holds both).
 */
export const AGENT_SOURCE_PREFIX = "agent:";

/** What a request's own session id is stored under when it starts with {@link AGENT_SOURCE_PREFIX}. */
const NEUTRALISED_SESSION_PREFIX = "session:";

/**
 * The `source_id` of a NON-agent action. A request's session id is the client's own string (a
 * trim, nothing more), so one that starts with the reserved `agent:` prefix is stored as
 * `session:<id>`: the reserved range is written only for an agent action, by the gateway. The
 * comparison is case-sensitive, exactly like the reader's range query (SQLite BINARY collation), and
 * a leading space already puts an id outside the range, so both are stored as sent. Every other
 * id, and none, is stored exactly as before. (`session:agent:x` from a client and a neutralised
 * `agent:x` read alike; neither is in the reserved range, which is all that matters.)
 */
function sessionSourceId(sessionId: string | undefined): string | null {
  if (sessionId === undefined) return null;
  return sessionId.startsWith(AGENT_SOURCE_PREFIX)
    ? `${NEUTRALISED_SESSION_PREFIX}${sessionId}`
    : sessionId;
}

/** How many UTF-16 units of the client's label the (unhashed) payload summary keeps. */
const AGENT_LABEL_SUMMARY_UNITS = 48;

/** The outside agent an action ran for: the gateway's capture id and the client's own label. */
export interface EgressAgent {
  readonly captureId: string;
  readonly label: string | null;
}

/** The label cut to {@link AGENT_LABEL_SUMMARY_UNITS}, never ending on half a surrogate pair. */
function clampAgentLabel(label: string | null): string | null {
  if (label === null || label.length <= AGENT_LABEL_SUMMARY_UNITS) return label;
  const cut = label.slice(0, AGENT_LABEL_SUMMARY_UNITS);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Throws unless `captureId` is the shape the gateway mints. The executor calls it at the START of an
 * agent action's run (before any sub-step, prompt or row) and `buildEgressEntry` calls it again.
 */
export function assertAgentCaptureId(captureId: string): void {
  if (!isCaptureId(captureId)) {
    throw new Error("egress: an outside agent's action must carry a gateway-minted capture id");
  }
}

/** The payload with the keys this module writes at the front removed, so a payload cannot overwrite them. */
function withoutReservedKeys(payload: PlannedAction["payload"]): Record<string, unknown> {
  if (payload === undefined) return {};
  const { agent: _agent, standingFire: _fire, ...rest } = payload;
  return rest;
}

/**
 * Build a ledger entry from a gated action. `now` is injected (DI; the clock seam).
 *
 * AD4: for an outside agent's action (`agent`), `source_id` is `agent:<captureId>`, the one hashed
 * field that names the agent, and it holds nothing the client chose (a request's own session id that
 * starts with the reserved prefix is stored neutralised, `sessionSourceId`): a capture id that is not the
 * shape the gateway mints THROWS (the caller builds the entry before any row is written, so
 * nothing is recorded or dispatched). The client's label goes only into the unhashed summary,
 * first and cut to 48 units, so it can never shift a field boundary of the row hash.
 */
export function buildEgressEntry(args: {
  readonly action: PlannedAction;
  readonly hitlStatus: EgressHitlStatus;
  readonly resultStatus: EgressResultStatus;
  readonly sessionId: string | undefined;
  readonly now: number;
  /** I55: the standing rule that approved the action, named first so the summary cap keeps it. */
  readonly standingFire?: { readonly ruleId: string; readonly fireId: string };
  /** AD4: the outside agent this action (or a sub-step of it) ran for. */
  readonly agent?: EgressAgent;
}): EgressEntry {
  if (args.agent !== undefined) assertAgentCaptureId(args.agent.captureId);
  const head: Record<string, unknown> = {
    ...(args.agent === undefined ? {} : { agent: { label: clampAgentLabel(args.agent.label) } }),
    ...(args.standingFire === undefined ? {} : { standingFire: args.standingFire }),
  };
  return {
    timestamp: args.now,
    sourceType: "task",
    sourceId:
      args.agent === undefined
        ? sessionSourceId(args.sessionId)
        : `${AGENT_SOURCE_PREFIX}${args.agent.captureId}`,
    destination: summarizeDestination(args.action.type),
    method: args.action.type,
    payloadSummary: redactEgressSummary(
      Object.keys(head).length === 0
        ? args.action.payload
        : { ...head, ...withoutReservedKeys(args.action.payload) },
    ),
    hitlStatus: args.hitlStatus,
    resultStatus: args.resultStatus,
  };
}
