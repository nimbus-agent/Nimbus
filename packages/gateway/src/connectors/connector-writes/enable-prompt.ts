// packages/gateway/src/connectors/connector-writes/enable-prompt.ts
// The consent text for `connector.writes.enable`: exactly which writes become model-offerable.
import { sanitisePreviewText } from "./preview.ts";

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
    const r = w as { toolId?: unknown; actionType?: unknown; wave?: unknown } | null;
    if (
      typeof r?.toolId !== "string" ||
      typeof r.actionType !== "string" ||
      typeof r.wave !== "number"
    ) {
      return undefined;
    }
    lines.push(
      `  ${sanitisePreviewText(r.toolId)}  ${sanitisePreviewText(r.actionType)}  wave ${r.wave}`,
    );
  }
  lines.push("", "Each call will still ask you before it runs.");
  return lines;
}
