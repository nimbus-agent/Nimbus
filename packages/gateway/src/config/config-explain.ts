// `config explain`: where each effective value comes from. Reads the layered snapshot
// (pack -> base -> profile) and puts a set, effective environment override on top.

import { DEFAULT_OPENAPI_CONFIG, parseOpenapiToml } from "../connectors/openapi-indexer-config.ts";
import { loadMultimodalConfig } from "../multimodal/multimodal-config.ts";
import { processEnvGet } from "../platform/env-access.ts";
import type { ProfileSource } from "./active-profile.ts";
import { CONFIG_ENV_OVERRIDES, isPolicyConstrainedPath } from "./config-env-overrides.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "./filesystem-toml.ts";
import {
  type FleetJobChecker,
  loadNimbusFleetFromConfigDir,
  resolveFleetJobs,
} from "./fleet-toml.ts";
import {
  type ConfigSnapshot,
  fallbackMessage,
  type LayeredConfig,
  type SnapshotLayer,
} from "./layered-config.ts";
import {
  type EffectiveEntry,
  type EffectiveSection,
  type LayerRef,
  UNPARSED_SECTION_HEADER,
} from "./layered-merge.ts";
import { loadNimbusMcpSinkFromConfigDir } from "./mcp-sink-toml.ts";
import {
  loadNimbusAgentsFromConfigDir,
  loadNimbusAuditFromConfigDir,
  loadNimbusAutomationFromConfigDir,
  loadNimbusBriefsFromConfigDir,
  loadNimbusChatopsFromConfigDir,
  loadNimbusCodeExecutionFromConfigDir,
  loadNimbusComputerUseFromConfigDir,
  loadNimbusConnectorsFromConfigDir,
  loadNimbusDecisionsFromConfigDir,
  loadNimbusDoraFromConfigDir,
  loadNimbusEmbeddingFromConfigDir,
  loadNimbusExtensionsFromConfigDir,
  loadNimbusFederationFromConfigDir,
  loadNimbusGlossaryFromConfigDir,
  loadNimbusIdentityFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLlmFromConfigDir,
  loadNimbusNegotiateFromConfigDir,
  loadNimbusOwnershipFromConfigDir,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPersonaFromConfigDir,
  loadNimbusPreflightFromConfigDir,
  loadNimbusPremortemFromConfigDir,
  loadNimbusQuorumFromConfigDir,
  loadNimbusScimFromConfigDir,
  loadNimbusSecurityFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
  loadNimbusShareHttpSink,
  loadNimbusToolGenerationFromConfigDir,
  loadNimbusTribalFromConfigDir,
  loadNimbusUpdaterFromConfigDir,
  loadNimbusUserFromConfigDir,
  loadNimbusVoiceFromConfigDir,
  loadTomlSectionFromConfig,
} from "./nimbus-toml.ts";
import { loadGlossaryManualFromConfigDir } from "./nimbus-toml-glossary-terms.ts";
import { loadNimbusWorkdayFromConfigDir } from "./nimbus-toml-workday.ts";
import { loadNimbusNotificationsFromConfigDir } from "./notifications-toml.ts";
import { loadNimbusOncallPushFromConfigDir } from "./oncall-push-toml.ts";
import { loadNimbusSessionFromConfigDir } from "./session-toml.ts";
import { loadNimbusTelemetryFromConfigDir } from "./telemetry-toml.ts";
import { parseString } from "./toml-primitives.ts";

/**
 * Each section id (unbracketed, as `sectionFallback` keys it) mapped to the config-dir loader that
 * reads it. `probeSection` runs the loader so a swallowed or refused error is on record before
 * `config explain` reports the section. Every id a loader passes to its fallback sink must be here.
 */
export const SECTION_LOADERS: Readonly<Record<string, (configDir: string) => unknown>> = {
  agents: loadNimbusAgentsFromConfigDir,
  audit: loadNimbusAuditFromConfigDir,
  automation: loadNimbusAutomationFromConfigDir,
  briefs: loadNimbusBriefsFromConfigDir,
  chatops: loadNimbusChatopsFromConfigDir,
  "ci.service": loadNimbusServiceConfigsFromConfigDir,
  code_execution: loadNimbusCodeExecutionFromConfigDir,
  computer_use: loadNimbusComputerUseFromConfigDir,
  connectors: loadNimbusConnectorsFromConfigDir,
  "connectors.workday": loadNimbusWorkdayFromConfigDir,
  decisions: loadNimbusDecisionsFromConfigDir,
  embedding: loadNimbusEmbeddingFromConfigDir,
  extensions: loadNimbusExtensionsFromConfigDir,
  federation: loadNimbusFederationFromConfigDir,
  "federation.preflight": loadNimbusPreflightFromConfigDir,
  "filesystem.roots": loadNimbusFilesystemRootsFromConfigDir,
  fleet: loadNimbusFleetFromConfigDir,
  glossary: loadNimbusGlossaryFromConfigDir,
  "glossary.terms": loadGlossaryManualFromConfigDir,
  "hitl.quorum": loadNimbusQuorumFromConfigDir,
  identity: loadNimbusIdentityFromConfigDir,
  lan: loadNimbusLanFromConfigDir,
  llm: loadNimbusLlmFromConfigDir,
  mcp_sink: loadNimbusMcpSinkFromConfigDir,
  "metrics.dora": loadNimbusDoraFromConfigDir,
  multimodal: loadMultimodalConfig,
  negotiate: loadNimbusNegotiateFromConfigDir,
  notifications: (configDir) => loadNimbusNotificationsFromConfigDir(configDir),
  "oncall.push": loadNimbusOncallPushFromConfigDir,
  openapi: (configDir) =>
    loadTomlSectionFromConfig(configDir, "openapi", DEFAULT_OPENAPI_CONFIG, parseOpenapiToml),
  ownership: loadNimbusOwnershipFromConfigDir,
  pagerduty: loadNimbusPagerdutyFromConfigDir,
  persona: (configDir) => loadNimbusPersonaFromConfigDir(configDir),
  premortem: loadNimbusPremortemFromConfigDir,
  scim: loadNimbusScimFromConfigDir,
  security: loadNimbusSecurityFromConfigDir,
  session: loadNimbusSessionFromConfigDir,
  "share.http_sink": loadNimbusShareHttpSink,
  telemetry: loadNimbusTelemetryFromConfigDir,
  tool_generation: loadNimbusToolGenerationFromConfigDir,
  tribal: loadNimbusTribalFromConfigDir,
  updater: loadNimbusUpdaterFromConfigDir,
  user: loadNimbusUserFromConfigDir,
  voice: loadNimbusVoiceFromConfigDir,
};

/**
 * Runs `sectionId`'s own loader against `reader`'s config dir, so its fallback (if any) is
 * recorded for the current snapshot even when nothing has loaded the section since the last edit.
 * A loader that throws is recorded as `refused: <message>`. The loader reaches the reader through
 * the registry (`getLayeredConfig`), so `reader` must be the registered one for its config dir.
 */
export function probeSection(reader: LayeredConfig, sectionId: string): string | undefined {
  const load = SECTION_LOADERS[sectionId];
  if (load !== undefined) {
    try {
      load(reader.configDir);
    } catch (err) {
      reader.recordSectionFallback(sectionId, `refused: ${fallbackMessage(err)}`);
    }
  }
  return reader.sectionFallback(sectionId);
}

/**
 * Sections read by another section's loader, mapped to the id that loader records under:
 * `[glossary.synonyms]` is parsed by the manual glossary loader, which records `glossary.terms`.
 */
export const SECTION_ALIASES: Readonly<Record<string, string>> = {
  "glossary.synonyms": "glossary.terms",
};

/**
 * The `SECTION_LOADERS` id owning `path`: the longest loader id or alias equal to, or a dotted
 * prefix of, it (an alias resolves to its target).
 */
export function sectionIdForPath(path: string): string | undefined {
  const wanted = unquote(path);
  let best: string | undefined;
  for (const id of [...Object.keys(SECTION_LOADERS), ...Object.keys(SECTION_ALIASES)]) {
    if ((wanted === id || wanted.startsWith(`${id}.`)) && id.length > (best?.length ?? -1)) {
      best = id;
    }
  }
  return best === undefined ? undefined : (SECTION_ALIASES[best] ?? best);
}

export type ExplainSource =
  | { readonly kind: "layer"; readonly layer: LayerRef }
  | { readonly kind: "env"; readonly envVar: string };

export type ExplainEntry = {
  readonly path: string;
  readonly value: string;
  readonly source: ExplainSource;
  readonly shadowed: readonly { readonly source: ExplainSource; readonly value: string }[];
};

export type ExplainResult = {
  readonly runningProfile: string;
  /** Where the running name came from; a restart re-resolves only a marker/default profile. */
  readonly runningProfileSource: ProfileSource;
  readonly markerProfile: string;
  readonly layers: readonly SnapshotLayer[];
  readonly entries: readonly ExplainEntry[];
  readonly blocks?: readonly {
    readonly header: string;
    readonly layer: LayerRef;
    readonly entries: readonly ExplainEntry[];
  }[];
  readonly policyMayRestrict: boolean;
  readonly sectionFallback?: string;
  readonly notes: readonly string[];
};

type EnvGet = (k: string) => string | undefined;

/** Splits on `.` outside double quotes; quotes stay in the segments. */
function splitPath(path: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of path) {
    if (ch === '"') quoted = !quoted;
    if (ch === "." && !quoted) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

const unquote = (s: string): string => s.replaceAll('"', "");

function entryPath(header: string | null, key: string): string {
  return header === null ? key : `${header}.${key}`;
}

function toExplainEntry(header: string | null, e: EffectiveEntry): ExplainEntry {
  return {
    path: entryPath(header, e.key),
    value: e.valRaw,
    source: { kind: "layer", layer: e.layer },
    // Newest shadowed value first.
    shadowed: [...e.shadowed].reverse().map((s) => ({
      source: { kind: "layer" as const, layer: s.layer },
      value: s.valRaw,
    })),
  };
}

/** Last-wins within a key: earlier same-layer values become shadowed, newest first. */
function collapseKey(header: string | null, same: readonly EffectiveEntry[]): ExplainEntry {
  const last = same.at(-1) as EffectiveEntry;
  const base = toExplainEntry(header, last);
  const earlier = same
    .slice(0, -1)
    .reverse()
    .map((e) => ({ source: base.source, value: e.valRaw }));
  return { ...base, shadowed: [...earlier, ...base.shadowed] };
}

function applyEnv(entry: ExplainEntry, env: EnvGet, notes: string[]): ExplainEntry {
  for (const o of CONFIG_ENV_OVERRIDES) {
    if (unquote(o.path) !== unquote(entry.path)) continue;
    const raw = env(o.envVar);
    if (raw === undefined) continue;
    const effective = o.effective(raw);
    if (effective === undefined) {
      notes.push(`${o.envVar} is set to "${raw}" but does not override this value`);
      continue;
    }
    return {
      path: entry.path,
      value: effective,
      source: { kind: "env", envVar: o.envVar },
      shadowed: [{ source: entry.source, value: entry.value }, ...entry.shadowed],
    };
  }
  return entry;
}

/** An override for a path no file sets: the env value alone is the source. */
function envOnlyEntry(path: string, env: EnvGet, notes: string[]): ExplainEntry | undefined {
  for (const o of CONFIG_ENV_OVERRIDES) {
    if (unquote(o.path) !== unquote(path)) continue;
    const raw = env(o.envVar);
    const effective = raw === undefined ? undefined : o.effective(raw);
    if (raw !== undefined && effective === undefined) {
      notes.push(`${o.envVar} is set to "${raw}" but does not override this value`);
    }
    if (effective !== undefined) {
      return {
        path: o.path,
        value: effective,
        source: { kind: "env", envVar: o.envVar },
        shadowed: [],
      };
    }
  }
  return undefined;
}

function blockFor(
  s: EffectiveSection,
  env: EnvGet,
  notes: string[],
): { header: string; layer: LayerRef; entries: ExplainEntry[] } | undefined {
  if (s.header === null || s.blockLayer === undefined) return undefined;
  return {
    header: s.header,
    layer: s.blockLayer,
    entries: s.entries.map((e) => applyEnv(toExplainEntry(s.header, e), env, notes)),
  };
}

function blockName(s: EffectiveSection): string | undefined {
  let name: string | undefined;
  for (const e of s.entries) if (e.key === "name") name = parseString(e.valRaw);
  return name;
}

/** Picks the plain section for `segs`: longest header prefix, exact quoted match on a tie. */
function resolvePlain(
  plain: readonly EffectiveSection[],
  segs: readonly string[],
): { section: EffectiveSection; key: string } | undefined {
  for (let k = segs.length - 1; k >= 0; k -= 1) {
    const rawPrefix = segs.slice(0, k).join(".");
    const matches = plain.filter((s) =>
      k === 0 ? s.header === null : s.header !== null && unquote(s.header) === unquote(rawPrefix),
    );
    if (matches.length === 0) continue;
    const section = matches.find((s) => s.header === rawPrefix) ?? matches[0];
    if (section !== undefined) return { section, key: segs.slice(k).join(".") };
  }
  return undefined;
}

/**
 * True when restarting the gateway would pick a different profile than the running one. An
 * argument or NIMBUS_PROFILE beats the marker, so only a marker- or default-resolved profile can
 * be changed by a new marker.
 */
export function restartWouldSwitch(
  source: ProfileSource,
  running: string,
  marker: string,
): boolean {
  return (source === "marker" || source === "default") && marker !== running;
}

const layerLabel = (l: LayerRef): string => `${l.kind} "${l.id}"`;

/**
 * Which job a path narrows the fleet notes to: `undefined` for every job (no path, or
 * `fleet.job`), the job name for `fleet.job.<name>`, `null` for a path outside `fleet.job`.
 */
function fleetJobScope(path: string | undefined): string | undefined | null {
  if (path === undefined) return undefined;
  const wanted = unquote(path);
  if (wanted === "fleet.job") return undefined;
  if (!wanted.startsWith("fleet.job.")) return null;
  return wanted.slice("fleet.job.".length);
}

function disabledJobNote(name: string, replaces: readonly LayerRef[]): string {
  const head = `fleet job "${name}" is disabled (enabled = false); `;
  return replaces.length === 0
    ? `${head}it disables nothing`
    : `${head}it disables ${replaces.map(layerLabel).join(", ")}`;
}

/**
 * Notes on `[[fleet.job]]` entries: what a stub disables, what a job replaced, what was dropped.
 * Built from the loader's own `resolveFleetJobs`, so explain cannot disagree with what ran.
 * `path` narrows it to one job (`fleet.job.<name>`); `fleet.job` or no path covers every job.
 */
function fleetJobNotes(
  sections: readonly EffectiveSection[],
  path: string | undefined,
  check: FleetJobChecker | undefined,
): string[] {
  const only = fleetJobScope(path);
  if (only === null) return [];
  const r = resolveFleetJobs(sections, check);
  const keep = (name: string | null): boolean => only === undefined || name === only;
  const notes: string[] = [];
  for (const d of r.disabled) {
    if (keep(d.name)) notes.push(disabledJobNote(d.name, d.origin.replaces));
  }
  for (const j of r.jobs) {
    const origin = r.origins.get(j.name);
    if (origin === undefined || origin.replaces.length === 0 || !keep(j.name)) continue;
    notes.push(
      `fleet job "${j.name}" from ${layerLabel(origin.layer)} replaces ${origin.replaces.map(layerLabel).join(", ")}`,
    );
  }
  for (const d of r.dropped) {
    if (keep(d.name)) notes.push(`fleet job "${d.name ?? "(unnamed)"}" is dropped: ${d.reason}`);
  }
  return notes;
}

function isAgentsPath(path: string | undefined): boolean {
  if (path === undefined) return false;
  const wanted = unquote(path);
  return wanted === "agents" || wanted.startsWith("agents.");
}

type ExplainBlock = { header: string; layer: LayerRef; entries: ExplainEntry[] };
type Explained = { entries: ExplainEntry[]; blocks: ExplainBlock[] };

/** No path: every plain key (last-wins collapsed), env-only overrides, then every array block. */
function explainWhole(
  plain: readonly EffectiveSection[],
  arrays: readonly EffectiveSection[],
  env: EnvGet,
  notes: string[],
): Explained {
  const entries: ExplainEntry[] = [];
  const blocks: ExplainBlock[] = [];
  for (const s of plain) {
    const byKey = new Map<string, EffectiveEntry[]>();
    for (const e of s.entries) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
    for (const same of byKey.values()) {
      entries.push(applyEnv(collapseKey(s.header, same), env, notes));
    }
  }
  for (const o of CONFIG_ENV_OVERRIDES) {
    if (entries.some((e) => unquote(e.path) === o.path)) continue;
    const only = envOnlyEntry(o.path, env, notes);
    if (only !== undefined) entries.push(only);
  }
  for (const s of arrays) {
    const b = blockFor(s, env, notes);
    if (b !== undefined) blocks.push(b);
  }
  return { entries, blocks };
}

/** One path: its plain key (or an env-only override), then the array blocks it names. */
function explainPath(
  plain: readonly EffectiveSection[],
  arrays: readonly EffectiveSection[],
  path: string,
  env: EnvGet,
  notes: string[],
): Explained {
  const segs = splitPath(path);
  const wanted = unquote(segs.join("."));
  const entries: ExplainEntry[] = [];
  const hit = resolvePlain(plain, segs);
  if (hit !== undefined) {
    const matching = hit.section.entries.filter((e) => unquote(e.key) === unquote(hit.key));
    if (matching.length > 0) {
      entries.push(applyEnv(collapseKey(hit.section.header, matching), env, notes));
    }
  }
  if (entries.length === 0) {
    const only = envOnlyEntry(path, env, notes);
    if (only !== undefined) entries.push(only);
  }
  const blocks = blocksNamedBy(arrays, wanted, env, notes);
  if (entries.length === 0 && blocks.length === 0) {
    notes.push(`no layer sets ${path}; the code default applies`);
  }
  return { entries, blocks };
}

/** The array blocks a path names: the whole header, or one block by its name. */
function blocksNamedBy(
  arrays: readonly EffectiveSection[],
  wanted: string,
  env: EnvGet,
  notes: string[],
): ExplainBlock[] {
  const blocks: ExplainBlock[] = [];
  for (const s of arrays) {
    if (s.header === null) continue;
    const h = unquote(s.header);
    const whole = h === wanted;
    const byName = wanted.startsWith(`${h}.`) && blockName(s) === wanted.slice(h.length + 1);
    if (!whole && !byName) continue;
    const b = blockFor(s, env, notes);
    if (b !== undefined) blocks.push(b);
  }
  return blocks;
}

/** Notes on packs the snapshot skipped, and on a pack list that could not be applied. */
function packNotes(
  snap: Pick<ConfigSnapshot, "skippedPacks" | "packListError">,
  profileName: string,
): string[] {
  const notes = snap.skippedPacks.map((p) => `pack "${p.packId}" skipped: ${p.reason}`);
  if (snap.packListError !== undefined) {
    notes.push(`packs for profile "${profileName}" not applied: ${snap.packListError}`);
  }
  return notes;
}

export function explainConfig(
  reader: LayeredConfig,
  path: string | undefined,
  env: EnvGet = processEnvGet,
  opts: {
    readonly fleetJobCheck?: FleetJobChecker;
    /**
     * Agent-visibility lines, injected because `config/` must not import `catalog/`. Called only
     * for an `agents` / `agents.*` path, so a bare explain shows owners without packs nothing new.
     */
    readonly agentVisibilityNotes?: () => readonly string[];
  } = {},
): ExplainResult {
  const snap = reader.snapshot();
  const notes: string[] = [];
  const sections = snap.doc.sections.filter(
    (s) => s.malformed === undefined && s.header !== UNPARSED_SECTION_HEADER,
  );
  const plain = sections.filter((s) => !s.isArray);
  const arrays = sections.filter((s) => s.isArray);
  const { entries, blocks } =
    path === undefined
      ? explainWhole(plain, arrays, env, notes)
      : explainPath(plain, arrays, path, env, notes);

  notes.push(...packNotes(snap, reader.profile.name));
  notes.push(...fleetJobNotes(snap.doc.sections, path, opts.fleetJobCheck));
  if (opts.agentVisibilityNotes !== undefined && isAgentsPath(path)) {
    notes.push(...opts.agentVisibilityNotes());
  }
  const running = reader.profile.name;
  const marker = reader.markerProfile();
  if (restartWouldSwitch(reader.profile.source, running, marker)) {
    notes.push(`profile switched to "${marker}" on disk; restart the gateway to apply`);
  }
  const sectionId = path === undefined ? undefined : sectionIdForPath(path);
  const sectionFallback = sectionId === undefined ? undefined : probeSection(reader, sectionId);
  const policyMayRestrict =
    path === undefined
      ? entries.some((e) => isPolicyConstrainedPath(e.path))
      : isPolicyConstrainedPath(path) || isPolicyConstrainedPath(unquote(path));
  return {
    runningProfile: running,
    runningProfileSource: reader.profile.source,
    markerProfile: marker,
    layers: snap.layers,
    entries,
    ...(blocks.length > 0 ? { blocks } : {}),
    policyMayRestrict,
    ...(sectionFallback !== undefined ? { sectionFallback } : {}),
    notes,
  };
}
