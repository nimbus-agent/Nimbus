import type { PlannedAction } from "./types.ts";

/**
 * The tool input of a planned action: `payload.input` when present, otherwise the flat payload with
 * the `mcpToolId` routing key dropped, otherwise `{}`. Pure module so display code (the connector
 * write preview) can share the exact normalisation the dispatcher sends.
 */
export function extractToolInput(action: PlannedAction): unknown {
  const p = action.payload;
  if (p === undefined) {
    return {};
  }
  if (Object.hasOwn(p, "input")) {
    return p["input"];
  }
  const rest: Record<string, unknown> = { ...p };
  delete rest["mcpToolId"];
  return rest;
}
