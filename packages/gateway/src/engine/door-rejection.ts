// packages/gateway/src/engine/door-rejection.ts
// Which executor refusals a connector-write door tells its caller about (Phase 28 AD3a-2a, D-6). The
// model door answers `{ refused: <the fixed reason> }` for them and the MCP act door stores the
// matching fixed code on the `rejected` action, so the two doors classify one way. Every other
// rejection (a plain decline, a mistyped confirmation, a non-human answer) is "declined" and
// carries nothing: the owner's reason is never handed back.
//
// Pure. The reasons are all FIXED gateway texts (a guard's, `WAVE4_BEFORE_REFUSAL`, the bound
// write's prepare, input and preflight refusals); none echoes an input value.
import { COMMIT_INPUT_REFUSALS } from "../connectors/connector-writes/commit-limits.ts";
import {
  IAC_INPUT_REFUSALS,
  IAC_PREFLIGHT_REFUSALS,
} from "../connectors/connector-writes/iac-limits.ts";
import {
  K8S_INPUT_REFUSALS,
  K8S_MODEL_REFUSALS,
  K8S_PREFLIGHT_REFUSALS,
} from "../connectors/connector-writes/k8s-limits.ts";
import type { ConnectorWriteRow } from "../connectors/connector-writes/types.ts";
import { WAVE4_BEFORE_REFUSAL } from "./before-state.ts";
import {
  CONFIRM_UNSUPPORTED_REASON,
  PREFLIGHT_FAILED_REASON,
  PREFLIGHT_NO_CONFIRM_REASON,
} from "./executor.ts";
import { PREPARE_REFUSALS } from "./prepare-step.ts";

/** The codes this classifier can give; each is a member of the capture sink's `ACTION_REJECT_CODES`. */
export const DOOR_REJECTION_CODES = [
  "ERR_ACTION_GUARD_REFUSED",
  "ERR_ACTION_BEFORE_STATE_UNREADABLE",
  "ERR_ACTION_PREPARE_REFUSED",
] as const;
export type DoorRejectionCode = (typeof DOOR_REJECTION_CODES)[number];

/** The fixed texts a bound write can be refused with before any prompt (never an error message). */
const FIXED_BOUND_REFUSALS: ReadonlySet<string> = new Set<string>([
  ...Object.values(PREPARE_REFUSALS),
  ...Object.values(COMMIT_INPUT_REFUSALS),
  ...Object.values(IAC_INPUT_REFUSALS),
  ...Object.values(IAC_PREFLIGHT_REFUSALS),
  ...Object.values(K8S_INPUT_REFUSALS),
  ...Object.values(K8S_PREFLIGHT_REFUSALS),
  ...Object.values(K8S_MODEL_REFUSALS),
  PREFLIGHT_NO_CONFIRM_REASON,
  PREFLIGHT_FAILED_REASON,
  CONFIRM_UNSUPPORTED_REASON,
]);

/**
 * The code of a rejection the executor made before any prompt, or `undefined` for a decline.
 * In this order: the row's own before-state guard reason; a Wave 4 row's unread current state; a
 * bound row's fixed prepare, input or preflight refusal. A row of `undefined` (a user-MCP type)
 * and an absent reason never classify.
 */
export function classifyDoorRejection(
  row: ConnectorWriteRow | undefined,
  reason: string | undefined,
): DoorRejectionCode | undefined {
  if (row === undefined || reason === undefined) return undefined;
  if (reason === row.before?.guard?.reason) return "ERR_ACTION_GUARD_REFUSED";
  if (row.wave === 4 && reason === WAVE4_BEFORE_REFUSAL) {
    return "ERR_ACTION_BEFORE_STATE_UNREADABLE";
  }
  if (row.bound !== undefined && FIXED_BOUND_REFUSALS.has(reason)) {
    return "ERR_ACTION_PREPARE_REFUSED";
  }
  return undefined;
}
