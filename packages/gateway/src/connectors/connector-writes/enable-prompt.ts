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

/**
 * How the prompt names each reason a found vault, or its daily note, is not writable
 * (`ObsidianGrantSkip` and `DailyNoteSkip`).
 */
const SKIP_REASONS: Readonly<Record<string, string>> = {
  "outside-roots": "outside your roots (reached through a link)",
  link: "reached through a link",
  missing: "could not be resolved",
  "home-or-root": "your home folder, a folder above it, or a drive root",
  protected: "overlaps a Nimbus folder",
  nested: "inside another vault, which covers it",
  "config-dir": "the daily-note folder is inside .obsidian or .git",
  "outside-vault": "the daily-note folder leaves the vault",
};

function stringList(v: unknown): readonly string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
}

/** The fixed sentences of the Obsidian widening (I15, the owner's file-only ruling). */
export const OBSIDIAN_WIDENING_LINES = [
  "Approving also lets the Obsidian connector's sandbox WRITE ONE FILE per vault: today's daily note (the date in UTC), in each Obsidian vault found under your [[filesystem.roots]], and any vault made there later (it already reads them):",
] as const;
export const OBSIDIAN_NOTHING_ELSE_LINE =
  "Nothing else in a vault becomes writable: not .obsidian (plugins, settings), not .git, no other note, no new file.";

/**
 * The Obsidian widening: approving the append also lets the connector's sandbox write today's
 * daily-note file in each vault, and nothing else. `undefined` when the scope is present but
 * malformed. An absent scope (no mesh in this process) still names the widening and its limit, and
 * says the files are not known.
 */
function obsidianScopeLines(scope: unknown): string[] | undefined {
  const lines: string[] = [...OBSIDIAN_WIDENING_LINES];
  if (scope === undefined) {
    lines.push("  (the files are not known to this gateway process)", OBSIDIAN_NOTHING_ELSE_LINE);
    return lines;
  }
  const rec = typeof scope === "object" && scope !== null ? (scope as Record<string, unknown>) : {};
  const roots = stringList(rec["roots"]);
  const notes = stringList(rec["notes"]);
  const skipped = rec["skipped"];
  if (roots === undefined || notes === undefined || !Array.isArray(skipped)) return undefined;
  for (const r of roots) lines.push(`  ${sanitisePreviewText(r)}`);
  lines.push("Daily notes it may write (one file a day):");
  if (notes.length === 0) lines.push("  (none)");
  for (const n of notes) lines.push(`  ${sanitisePreviewText(n)}`);
  for (const x of skipped as unknown[]) {
    const e = x as { path?: unknown; reason?: unknown } | null;
    if (typeof e?.path !== "string" || typeof e.reason !== "string") return undefined;
    if (!Object.hasOwn(SKIP_REASONS, e.reason)) return undefined;
    lines.push(`  not writable: ${sanitisePreviewText(e.path)} (${SKIP_REASONS[e.reason]})`);
  }
  lines.push(OBSIDIAN_NOTHING_ELSE_LINE);
  return lines;
}

/** The fixed sentences of the iac approval (D2, I15): what a Terraform run in an approved directory can do. */
export const IAC_CODE_LINE =
  "Terraform runs the code in these directories (providers, provisioners, external data sources) with the credential below and write access to them; Nimbus does not read or police it.";
export const IAC_NO_DOWNLOAD_LINE =
  "Provider and module downloads are not allowed: run terraform init yourself.";
export const IAC_EACH_APPLY_LINE =
  "Each apply will still show the plan and ask you to type the target.";
const IAC_HOST_SCOPE_LINES: Readonly<Record<string, string>> = {
  per_host: "Hosts are enforced one by one on this system.",
  per_port:
    "This platform limits the port, not the host: code in an approved directory could send the credential to any host on port 443.",
  all_or_nothing:
    "This platform limits the port, not the host: code in an approved directory could send the credential to any host on port 443.",
};

/** The iac scope lines; `undefined` when the scope is missing or malformed (refuse, never guess). */
function iacScopeLines(scope: unknown): string[] | undefined {
  if (typeof scope !== "object" || scope === null) return undefined;
  const rec = scope as Record<string, unknown>;
  const workdirs = stringList(rec["workdirs"]);
  const clouds = stringList(rec["clouds"]);
  const hosts = stringList(rec["hosts"]);
  const envNames = rec["envNames"];
  const hostScope = rec["hostScope"];
  if (
    workdirs === undefined ||
    clouds === undefined ||
    hosts === undefined ||
    typeof envNames !== "object" ||
    envNames === null ||
    typeof hostScope !== "string" ||
    !Object.hasOwn(IAC_HOST_SCOPE_LINES, hostScope)
  ) {
    return undefined;
  }
  const lines = ["Approving also lets Terraform run in these directories:"];
  if (workdirs.length === 0) lines.push("  (no directory: only CloudFormation)");
  for (const w of workdirs) lines.push(`  ${sanitisePreviewText(w)}`);
  lines.push(IAC_CODE_LINE);
  for (const c of clouds) {
    const names = stringList((envNames as Record<string, unknown>)[c]);
    if (names === undefined) return undefined;
    lines.push(
      `Credential for ${sanitisePreviewText(c)} (environment variable names): ${names.map(sanitisePreviewText).join(", ")}`,
    );
  }
  if (clouds.length === 0) lines.push("No cloud credential is granted.");
  lines.push("Hosts it may reach:");
  if (hosts.length === 0) lines.push("  (none)");
  for (const h of hosts) lines.push(`  ${sanitisePreviewText(h)}`);
  lines.push(IAC_HOST_SCOPE_LINES[hostScope] as string, IAC_NO_DOWNLOAD_LINE, IAC_EACH_APPLY_LINE);
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
  if (service === "iac") {
    const scopeLines = iacScopeLines(payload?.["iacGrants"]);
    if (scopeLines === undefined) return undefined;
    lines.push("", ...scopeLines);
  }
  lines.push("", "Each call will still ask you before it runs.");
  return lines;
}
