/**
 * DECLARATION-ONLY. Do not add runtime logic to this file.
 *
 * Coverage-exempt by exact path, for the reason `exec/exec-result.ts` is: a file with no executable
 * statement emits no lcov record, reads as 0%, and can never rejoin the floor. The moment a function
 * or constant lands here that exemption becomes a hole rather than an accounting fact — put such
 * code in `cu-session.ts` or `cu-gate.ts`, which are gated normally.
 */
import type { CuLane } from "../config/nimbus-toml.ts";

/** Browser lane target. TWO origin sets (spec § 3.5.1), both approved up front, neither widenable. */
export interface CuBrowserTarget {
  /** Where the agent may navigate (`document` / `sub_frame` resource types). */
  readonly navigateOrigins: readonly string[];
  /** Additionally reachable by script-initiated requests (`fetch`/XHR/`eventsource`/`websocket`). */
  readonly scriptOrigins: readonly string[];
}

export type CuTarget = CuBrowserTarget;

/** Immutable once approved. Frozen at construction — widening is unrepresentable, not discouraged. */
export interface CuEnvelope {
  readonly sessionId: string;
  readonly lane: CuLane;
  readonly target: CuTarget;
  readonly maxActions: number;
  readonly maxWallClockMs: number;
  readonly approvedAt: number;
}

/** `observing` never prompts; `actuating` ALWAYS prompts, and its approval is single-use. */
export type CuActionClass = "observing" | "actuating";

export type CuOutcome =
  | "refused_before_consent"
  | "denied_by_owner"
  | "actuated"
  | "failed_after_approval"
  | "refused_out_of_envelope"
  | "terminated_budget"
  | "terminated_wall_clock"
  | "terminated_target_lost";

export type CuBudgetVerdict =
  | { readonly ok: true; readonly seq: number }
  | { readonly ok: false; readonly reason: "budget" | "wall_clock" | "closed" };
