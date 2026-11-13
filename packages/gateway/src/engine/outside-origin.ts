import type { PlannedAction } from "./types.ts";

/**
 * Who proposed an action, read in ONE place so the two outside origins cannot drift (Phase 28 AD1,
 * invariants I20 and I53, static D40(b)). `origin` is set only by the gateway (never from IPC, a
 * payload or a door) and only ever REMOVES power: a delegate never approves such an action (I20), a
 * standing rule never matches it (I55) and the before-state runner reads for it (D40). Whether
 * HITL is required stays decided by `type` alone (I3); a `proposer` alone is display data and never
 * marks an outside origin.
 *
 * No other gateway file compares an action's `origin` to a literal (pinned in
 * `security-invariants.test.ts`); the standing-rule check refuses any origin at all.
 */

/** True for an action the conversational model proposed (`origin: "model"`, I53). */
export function isModelOrigin(action: Pick<PlannedAction, "origin">): boolean {
  return action.origin === "model";
}

/** True for an action an outside MCP client proposed (`origin: "agent"`, I28). */
export function isAgentOrigin(action: Pick<PlannedAction, "origin">): boolean {
  return action.origin === "agent";
}

/** True for either outside origin: no delegate, no standing rule, a before-state read. */
export function isOutsideOrigin(action: Pick<PlannedAction, "origin">): boolean {
  return isModelOrigin(action) || isAgentOrigin(action);
}
