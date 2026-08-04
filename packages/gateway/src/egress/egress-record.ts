import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { PlannedAction } from "../engine/types.ts";
import type { EgressSourceType } from "./egress-source-type.ts";

/** Max body bytes for `payload_summary` before the redactor appends `…[truncated]`. */
const EGRESS_SUMMARY_MAX_BYTES = 256;

export type EgressResultStatus = "authorized" | "blocked";
export type EgressHitlStatus = "approved" | "not_required" | "rejected";

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

/** Build a ledger entry from a gated action. `now` is injected (DI; the clock seam). */
export function buildEgressEntry(args: {
  readonly action: PlannedAction;
  readonly hitlStatus: EgressHitlStatus;
  readonly resultStatus: EgressResultStatus;
  readonly sessionId: string | undefined;
  readonly now: number;
}): EgressEntry {
  return {
    timestamp: args.now,
    sourceType: "task",
    sourceId: args.sessionId ?? null,
    destination: summarizeDestination(args.action.type),
    method: args.action.type,
    payloadSummary: redactEgressSummary(args.action.payload),
    hitlStatus: args.hitlStatus,
    resultStatus: args.resultStatus,
  };
}
