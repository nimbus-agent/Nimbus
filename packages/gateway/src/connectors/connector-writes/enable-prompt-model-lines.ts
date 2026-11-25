// packages/gateway/src/connectors/connector-writes/enable-prompt-model-lines.ts
// One write's line of the `connector.writes.enable` prompt for the model door (split out of
// `enable-prompt.ts`, which builds the whole prompt, with no behaviour change).
import { sanitisePreviewText } from "./preview.ts";

/** The marker each write's line carries, by its `state` (F7). */
const STATE_MARKERS: Readonly<Record<string, string>> = {
  already_approved: "(offered to the model)",
  newly_offerable: "(new: offered after you approve)",
  not_offerable: "(not offered yet)",
};

function markerFor(state: unknown, offerable: boolean): string | undefined {
  if (typeof state !== "string" || !Object.hasOwn(STATE_MARKERS, state)) return undefined;
  // A state that contradicts `offerable` is malformed: never mark a write offered that is not.
  if ((state === "not_offerable") === offerable) return undefined;
  return STATE_MARKERS[state];
}

/** One write's line of the model door's prompt; undefined when the row is malformed (the prompt is refused). */
export function modelWriteLine(w: unknown): string | undefined {
  const r = w as {
    toolId?: unknown;
    actionType?: unknown;
    wave?: unknown;
    offerable?: unknown;
    state?: unknown;
    reason?: unknown;
  } | null;
  if (
    typeof r?.toolId !== "string" ||
    typeof r.actionType !== "string" ||
    typeof r.wave !== "number" ||
    typeof r.offerable !== "boolean"
  ) {
    return undefined;
  }
  const marker = markerFor(r.state, r.offerable);
  if (marker === undefined) return undefined;
  if (r.reason !== undefined && (typeof r.reason !== "string" || r.offerable)) return undefined;
  // A write not offered because its credential lacks a scope says what to do (SA2).
  const shown =
    typeof r.reason === "string" ? `(not offered yet: ${sanitisePreviewText(r.reason)})` : marker;
  return `  ${sanitisePreviewText(r.toolId)}  ${sanitisePreviewText(r.actionType)}  wave ${r.wave}  ${shown}`;
}
