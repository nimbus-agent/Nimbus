// packages/gateway/src/connectors/connector-writes/enable-prompt.ts
// The consent text for `connector.writes.enable`: exactly which writes become model-offerable.
import { OBSIDIAN_APPEND_TOOL_ID } from "./enablement-store.ts";
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

/** How the prompt names each reason a found vault is not writable (`ObsidianGrantSkip`). */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  "outside-roots": "outside your roots (reached through a link)",
  link: "reached through a link",
  missing: "could not be resolved",
  "home-or-root": "your home folder, a folder above it, or a drive root",
  protected: "overlaps a Nimbus folder",
  nested: "inside another vault, which covers it",
};

function stringList(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/**
 * The Obsidian widening (I15, OR-B4-1, R9): approving the append also lets the connector's sandbox
 * write inside the vaults. `undefined` when the scope is present but malformed. An absent scope
 * (no mesh in this process) still names the widening and says the folders are not known.
 */
function obsidianScopeLines(scope: unknown): string[] | undefined {
  const lines = [
    "Approving also lets the Obsidian connector's sandbox WRITE inside each Obsidian vault found under your [[filesystem.roots]] (it already reads them):",
  ];
  if (scope === undefined) {
    lines.push("  (the folders are not known to this gateway process)");
    return lines;
  }
  const rec = typeof scope === "object" && scope !== null ? (scope as Record<string, unknown>) : {};
  const roots = stringList(rec["roots"]);
  const vaults = stringList(rec["vaults"]);
  const skipped = rec["skipped"];
  if (roots === undefined || vaults === undefined || !Array.isArray(skipped)) return undefined;
  for (const r of roots) lines.push(`  ${sanitisePreviewText(r)}`);
  lines.push("Vaults found now:");
  if (vaults.length === 0) lines.push("  (none)");
  for (const v of vaults) lines.push(`  ${sanitisePreviewText(v)}`);
  for (const s of skipped as unknown[]) {
    const e = s as { path?: unknown; reason?: unknown } | null;
    if (typeof e?.path !== "string" || typeof e.reason !== "string") return undefined;
    if (!Object.hasOwn(SKIP_REASONS, e.reason)) return undefined;
    lines.push(`  not writable: ${sanitisePreviewText(e.path)} (${SKIP_REASONS[e.reason]})`);
  }
  return lines;
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
  const appendOffered = (writes as unknown[]).some(
    (w) =>
      (w as { toolId?: unknown }).toolId === OBSIDIAN_APPEND_TOOL_ID &&
      (w as { offerable?: unknown }).offerable === true,
  );
  if (service === "obsidian" && appendOffered) {
    const scopeLines = obsidianScopeLines(payload?.["fileWriteScope"]);
    if (scopeLines === undefined) return undefined;
    lines.push("", ...scopeLines);
  }
  lines.push("", "Each call will still ask you before it runs.");
  return lines;
}
