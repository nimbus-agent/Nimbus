// packages/gateway/src/connectors/connector-writes/reversibility-label.ts
// The reversibility a label may claim BEFORE any before-read: a conditionally reversible row (the Unleash
// toggle) reads "reversible only if ...", never plain "reversible". Looked up by action type, as the gate
// does (I3). Captured before-state is never shown in a prompt (IC5a), so a prompt states the condition and
// the owner reads the state itself in the `Before:` block; the undo path, which holds the capture, judges
// the call itself (`callIsReversible`, `notReversibleBecause` in `reversibility.ts`).
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { reversibilityConditionOf } from "./reversibility.ts";

const TOOL_BY_TYPE: ReadonlyMap<string, string> = new Map(
  CONNECTOR_WRITE_ROWS.map((r) => [r.actionType, r.toolId] as const),
);

/** The condition of the row under `actionType`, when its reversibility holds only for some calls. */
export function reversibilityConditionForType(
  actionType: string,
): { readonly condition: string; readonly otherwise: string } | undefined {
  const toolId = TOOL_BY_TYPE.get(actionType);
  return toolId === undefined ? undefined : reversibilityConditionOf(toolId);
}
