// packages/gateway/src/connectors/connector-writes/enable-prompt.ts
// The consent text for `connector.writes.enable`: exactly which writes become model-offerable.
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

/** One line per write, then the fixed sentence; undefined when the payload is malformed. */
export function enableWritesPromptLines(
  payload: Record<string, unknown> | undefined,
): string[] | undefined {
  const service = payload?.["service"];
  const maxWave = payload?.["maxWave"];
  const writes = payload?.["writes"];
  if (typeof service !== "string" || typeof maxWave !== "number" || !Array.isArray(writes)) {
    return undefined;
  }
  const lines = [`Service: ${sanitisePreviewText(service)}`, `Up to wave: ${maxWave}`];
  for (const w of writes as unknown[]) {
    const r = w as {
      toolId?: unknown;
      actionType?: unknown;
      wave?: unknown;
      offerable?: unknown;
      state?: unknown;
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
    lines.push(
      `  ${sanitisePreviewText(r.toolId)}  ${sanitisePreviewText(r.actionType)}  wave ${r.wave}  ${marker}`,
    );
  }
  lines.push("", "Each call will still ask you before it runs.");
  return lines;
}
