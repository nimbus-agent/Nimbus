import { existsSync, readFileSync } from "node:fs";
import {
  fallbackMessage,
  getLayeredConfig,
  layerReadError,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  type EffectiveSection,
  type LayerRef,
  mergeLayerDocs,
  parseLayerDoc,
} from "./layered-merge.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export interface NimbusFleetToml {
  readonly enabled: boolean;
  readonly allowRemote: boolean;
  readonly remoteCallBudget: number;
  readonly minIdleSeconds: number;
  readonly requireAcPower: boolean;
  readonly retentionDays: number;
}

export type FleetJobParamValue = string | number;

export const SWEEP_KINDS = ["paths", "services", "symbols", "terms"] as const;
export type SweepKind = (typeof SWEEP_KINDS)[number];

/** A sweep's per-run cap ceiling — refused above, never clamped (the `media allow-remote --limit` posture). */
export const MAX_SWEEP_SUBJECTS = 500;

/** Kinds whose subjects carry a repo-relative path `path_prefix` can match. */
const PATH_PREFIX_KINDS: ReadonlySet<SweepKind> = new Set<SweepKind>(["paths", "symbols"]);

export interface FleetJobSweepToml {
  readonly kind: SweepKind;
  readonly maxSubjects: number;
  readonly pathPrefix: string | null;
}

function isSweepKind(s: string): s is SweepKind {
  return (SWEEP_KINDS as readonly string[]).includes(s);
}

export interface NimbusFleetJobToml {
  readonly name: string;
  readonly agent: string;
  readonly intervalSeconds: number;
  readonly params: Readonly<Record<string, FleetJobParamValue>>;
  readonly digestMinDelta: number;
  readonly sweep: FleetJobSweepToml | null;
}

export const DEFAULT_FLEET_CONFIG: NimbusFleetToml = Object.freeze({
  enabled: false,
  allowRemote: false,
  remoteCallBudget: 0,
  minIdleSeconds: 900,
  requireAcPower: true,
  retentionDays: 14,
});

export class FleetConfigError extends Error {}

/** `since_ms` → `sinceMs`. Flat keys only: the parser has no inline-table support. */
function camel(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

const JOB_RESERVED = new Set([
  "name",
  "agent",
  "interval_seconds",
  "enabled",
  "digest_min_delta",
  "sweep",
  "max_subjects",
  "path_prefix",
]);

/**
 * Apply one `[fleet]` key to the accumulating config. A malformed value is IGNORED here and falls
 * through to `DEFAULT_FLEET_CONFIG` at the call site — with one exception, `retention_days`, which
 * throws rather than defaulting. An unrecognised key is ignored.
 */
function applyFleetKey(out: Record<string, boolean | number>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled":
    case "allow_remote":
    case "require_ac_power": {
      const b = parseBool(valRaw);
      if (b !== undefined) out[camel(key)] = b;
      return;
    }
    case "remote_call_budget":
    case "min_idle_seconds": {
      // Zero is MEANINGFUL for both and must stay expressible: `remote_call_budget = 0` is what
      // `allow_remote = false` implies and is what DEFAULT_FLEET_CONFIG ships, and
      // `min_idle_seconds = 0` reads as "no idle requirement". Only `retention_days` below
      // raises the bound.
      const n = parseIntDec(valRaw);
      if (n !== undefined && n >= 0) out[camel(key)] = n;
      return;
    }
    case "retention_days": {
      // Refused below 1 rather than defaulted. `fleet-store.ts`'s `pruneRuns` deletes rows with
      // `started_at <= cutoff`, so at retention 0 the prune a run performs on completion removes
      // that same run — `runOnce` then returns a runId naming no row, and the durable record the
      // rest of this subsystem is built to keep honest is gone the moment it is written. There is
      // no safe reading of 0, so it is a config error rather than a silent fallback to 14.
      //
      // A MALFORMED value still falls through to the default, as the keys above do: writing a
      // number we can read and refuse is a different act from writing nonsense.
      const n = parseIntDec(valRaw);
      if (n === undefined) return;
      if (n < 1) {
        throw new FleetConfigError(
          `[fleet] retention_days must be >= 1 (got ${String(n)}); a zero or negative ` +
            `retention makes a run prune its own record on completion`,
        );
      }
      out["retentionDays"] = n;
      return;
    }
    default:
      return;
  }
}

export function parseNimbusTomlFleet(source: string): NimbusFleetToml {
  const out: Record<string, boolean | number> = {};
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[fleet]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    applyFleetKey(out, kv.key, kv.valRaw);
  }

  const config: NimbusFleetToml = { ...DEFAULT_FLEET_CONFIG, ...out };
  // Refused rather than silently corrected: `allow_remote` with no budget reads as permission, and
  // shipping it as an unbounded or zero-call grant are both wrong answers to a question the owner
  // clearly meant to answer.
  if (config.allowRemote && config.remoteCallBudget <= 0) {
    throw new FleetConfigError(
      "[fleet] allow_remote = true requires remote_call_budget > 0 (an unbounded overnight " +
        "remote grant must not be expressible)",
    );
  }
  return config;
}

/** One `[[fleet.job]]` block as read, before `validateJobDraft` turns it into a job. */
type FleetJobDraft = {
  name?: string;
  agent?: string;
  intervalSeconds?: number;
  /** Set when `interval_seconds` is present at all, readable or not. */
  intervalRaw?: string;
  enabledRaw?: string;
  params: Record<string, FleetJobParamValue>;
  digestMinDelta?: number;
  sweep?: string;
  maxSubjectsRaw?: string;
  pathPrefix?: string;
};

/** One key/value line of a `[[fleet.job]]` block, from the text scanner or an `EffectiveSection`. */
type FleetJobEntry = { readonly key: string; readonly valRaw: string };

/**
 * Apply one `[[fleet.job]]` key to the block being read. Nothing throws here: validation runs over
 * the whole block in `validateJobDraft`, so every refusal can name the job whatever the key order.
 */
function applyJobKey(cur: FleetJobDraft, key: string, valRaw: string): void {
  if (key === "name") {
    cur.name = parseString(valRaw);
    return;
  }
  if (key === "agent") {
    cur.agent = parseString(valRaw);
    return;
  }
  if (key === "interval_seconds") {
    cur.intervalRaw = valRaw;
    const n = parseIntDec(valRaw);
    if (n !== undefined) cur.intervalSeconds = n;
    return;
  }
  if (key === "enabled") {
    cur.enabledRaw = valRaw;
    return;
  }
  if (key === "digest_min_delta") {
    const n = parseIntDec(valRaw);
    if (n !== undefined) cur.digestMinDelta = n;
    return;
  }
  if (key === "sweep") {
    cur.sweep = parseString(valRaw);
    return;
  }
  if (key === "max_subjects") {
    // Kept RAW: validity depends on whether `sweep` is set, which a later line may decide.
    cur.maxSubjectsRaw = valRaw;
    return;
  }
  if (key === "path_prefix") {
    cur.pathPrefix = parseString(valRaw);
    return;
  }
  if (!JOB_RESERVED.has(key)) {
    const n = parseIntDec(valRaw);
    cur.params[camel(key)] = n ?? parseString(valRaw);
  }
}

function readJobDraft(entries: readonly FleetJobEntry[]): FleetJobDraft {
  const draft: FleetJobDraft = { params: {} };
  for (const e of entries) applyJobKey(draft, e.key, e.valRaw);
  return draft;
}

/** A block with nothing in it is not a job (today's rule: no name, agent or interval). */
function isEmptyDraft(d: FleetJobDraft): boolean {
  return d.name === undefined && d.agent === undefined && d.intervalSeconds === undefined;
}

/**
 * Rules 3–5 of the sweep spec (§ 4) — the syntactic half. Rules 1, 2 and 6 need the agent map and
 * run in `fleet/fleet-sweep-support.ts`, since `config/` does not import `fleet/`.
 */
function resolveSweep(name: string, d: FleetJobDraft): FleetJobSweepToml | null {
  if (d.sweep === undefined) {
    if (d.maxSubjectsRaw !== undefined || d.pathPrefix !== undefined) {
      throw new FleetConfigError(
        `[[fleet.job]] ${name} sets max_subjects or path_prefix without sweep`,
      );
    }
    return null;
  }
  const kind = d.sweep;
  if (!isSweepKind(kind)) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} has unknown sweep "${kind}" (expected one of ${SWEEP_KINDS.join(", ")})`,
    );
  }
  const n = d.maxSubjectsRaw === undefined ? undefined : parseIntDec(d.maxSubjectsRaw);
  if (n === undefined || n < 1 || n > MAX_SWEEP_SUBJECTS) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} requires max_subjects between 1 and ${String(MAX_SWEEP_SUBJECTS)} ` +
        `when sweep is set (refused, not clamped; an unbounded sweep must not be expressible)`,
    );
  }
  if (d.pathPrefix === "") {
    // Every path starts with "", so an empty prefix would silently mean "no narrowing". Refused, not
    // trimmed or dropped: a path may legally contain spaces, so whitespace is kept verbatim.
    throw new FleetConfigError(`[[fleet.job]] ${name} path_prefix must not be empty`);
  }
  if (d.pathPrefix !== undefined && !PATH_PREFIX_KINDS.has(kind)) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} path_prefix applies only to sweep = "paths" or "symbols"`,
    );
  }
  return { kind, maxSubjects: n, pathPrefix: d.pathPrefix ?? null };
}

/** A parsed block: a full job (enabled or not), or a disabling stub that names a job only. */
type FleetJobBlock =
  | { readonly job: NimbusFleetJobToml; readonly enabled: boolean }
  | { readonly stub: { readonly name: string; readonly agent: string | null } };

/**
 * Validate a non-empty draft. An INCOMPLETE enabled block is a job the owner meant to configure, so
 * it is refused rather than defaulted (a schedule they did not choose). `enabled = false` relaxes
 * only `agent` and `interval_seconds`: every other field that is present is still checked.
 */
function validateJobDraft(draft: FleetJobDraft): FleetJobBlock {
  const { name, agent, intervalSeconds, params, digestMinDelta } = draft;
  if (name === undefined) throw new FleetConfigError("[[fleet.job]] requires name");
  let enabled = true;
  if (draft.enabledRaw !== undefined) {
    const b = parseBool(draft.enabledRaw);
    if (b === undefined) {
      throw new FleetConfigError(`[[fleet.job]] ${name} enabled must be true or false`);
    }
    enabled = b;
  }
  // A zero admits every metric whose absolute delta is >= 0 — that is, every metric, including ones
  // that did not move — so it turns the threshold inside out and reports MORE than no threshold at
  // all. A malformed value still falls through to the default, as it always has.
  if (digestMinDelta !== undefined && digestMinDelta < 1) {
    throw new FleetConfigError(
      `[[fleet.job]] ${name} digest_min_delta must be >= 1 ` +
        `(got ${String(digestMinDelta)}); a zero would report every metric, including unchanged ones`,
    );
  }
  if (agent === undefined && enabled) {
    throw new FleetConfigError(`[[fleet.job]] ${name} requires agent`);
  }
  const intervalBad =
    draft.intervalRaw !== undefined && (intervalSeconds === undefined || intervalSeconds <= 0);
  if (intervalBad || (intervalSeconds === undefined && enabled)) {
    throw new FleetConfigError(`[[fleet.job]] ${name} requires interval_seconds > 0`);
  }
  const sweep = resolveSweep(name, draft);
  if (agent === undefined || intervalSeconds === undefined) {
    return { stub: { name, agent: agent ?? null } };
  }
  return {
    job: { name, agent, intervalSeconds, params, digestMinDelta: digestMinDelta ?? 1, sweep },
    enabled,
  };
}

/** One block's entries to a parsed block; `undefined` for an empty block. Throws `FleetConfigError`. */
function parseFleetJobBlock(entries: readonly FleetJobEntry[]): FleetJobBlock | undefined {
  const draft = readJobDraft(entries);
  return isEmptyDraft(draft) ? undefined : validateJobDraft(draft);
}

/**
 * The STRICT reader, for the pack check: throws on the first block error, a duplicate name or a
 * stub. Returns enabled jobs and full disabled ones alike; nothing schedules from this list.
 */
export function parseNimbusTomlFleetJobs(source: string): NimbusFleetJobToml[] {
  const jobs: NimbusFleetJobToml[] = [];
  const seen = new Set<string>();
  for (const entries of fleetJobBlocks(source)) {
    const parsed = parseFleetJobBlock(entries);
    if (parsed === undefined) continue;
    if ("stub" in parsed) {
      const missing = parsed.stub.agent === null ? "agent" : "interval_seconds > 0";
      throw new FleetConfigError(`[[fleet.job]] ${parsed.stub.name} requires ${missing}`);
    }
    if (seen.has(parsed.job.name)) {
      throw new FleetConfigError(`[[fleet.job]] duplicate name: ${parsed.job.name}`);
    }
    seen.add(parsed.job.name);
    jobs.push(parsed.job);
  }
  return jobs;
}

/** Each `[[fleet.job]]` block's key/value entries, in file order (empty blocks included). */
function fleetJobBlocks(source: string): FleetJobEntry[][] {
  const blocks: FleetJobEntry[][] = [];
  let cur: FleetJobEntry[] | undefined;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      cur = undefined;
      if (trimmed === "[[fleet.job]]") {
        cur = [];
        blocks.push(cur);
      }
      continue;
    }
    if (cur === undefined) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) cur.push(kv);
  }
  return blocks;
}

export type FleetJobOrigin = { readonly layer: LayerRef; readonly replaces: readonly LayerRef[] };
export type FleetDisabledJob = {
  readonly name: string;
  readonly agent: string | null;
  readonly origin: FleetJobOrigin;
};
export type FleetDroppedJob = {
  readonly name: string | null;
  readonly layer: LayerRef;
  readonly reason: string;
};
/** The check config/ cannot do itself (agent eligibility, sweep support). A reason string drops the job. */
export type FleetJobChecker = (job: NimbusFleetJobToml) => string | undefined;
export type FleetJobsResolved = {
  /** Enabled and valid: what the scheduler runs. */
  readonly jobs: NimbusFleetJobToml[];
  /** One per entry in `jobs`. */
  readonly origins: ReadonlyMap<string, FleetJobOrigin>;
  readonly disabled: FleetDisabledJob[];
  readonly dropped: FleetDroppedJob[];
};

/** `FleetJobsResolved` while it is being built: `origins` still writable. */
type FleetJobsResolving = FleetJobsResolved & { origins: Map<string, FleetJobOrigin> };

/**
 * Resolve each effective `[[fleet.job]]` block ON ITS OWN into scheduled, disabled or dropped, so
 * one bad job no longer takes the whole fleet down. A dropped higher-layer job does not bring back
 * the lower one it replaced: the merge already removed it, and an override the owner wrote is not
 * silently swapped for the one they meant to replace.
 */
export function resolveFleetJobs(
  sections: readonly EffectiveSection[],
  check?: FleetJobChecker,
): FleetJobsResolved {
  const out: FleetJobsResolving = {
    jobs: [],
    origins: new Map(),
    disabled: [],
    dropped: [],
  };
  const seen = new Set<string>();
  for (const s of sections) {
    const layer = s.blockLayer;
    if (!s.isArray || s.header !== "fleet.job" || layer === undefined) continue;
    const draft = readJobDraft(s.entries);
    if (isEmptyDraft(draft)) continue;
    const name = draft.name ?? null;
    // After the merge only same-layer copies can share a name, so the LATER one is dropped even
    // when the first copy was itself dropped.
    if (name !== null) {
      if (seen.has(name)) {
        out.dropped.push({ name, layer, reason: `[[fleet.job]] duplicate name: ${name}` });
        continue;
      }
      seen.add(name);
    }
    const parsed = validateOrDrop(draft, name, layer, out.dropped);
    if (parsed !== undefined)
      placeJobBlock(parsed, { layer, replaces: s.replaces ?? [] }, check, out);
  }
  return out;
}

/** A draft validated, or its `FleetConfigError` recorded in `dropped` (then `undefined`). */
function validateOrDrop(
  draft: FleetJobDraft,
  name: string | null,
  layer: LayerRef,
  dropped: FleetDroppedJob[],
): FleetJobBlock | undefined {
  try {
    return validateJobDraft(draft);
  } catch (err) {
    if (!(err instanceof FleetConfigError)) throw err;
    dropped.push({ name, layer, reason: err.message });
    return undefined;
  }
}

/** A valid block into disabled (a stub, or `enabled = false`), dropped (by `check`) or scheduled. */
function placeJobBlock(
  parsed: FleetJobBlock,
  origin: FleetJobOrigin,
  check: FleetJobChecker | undefined,
  out: FleetJobsResolving,
): void {
  if ("stub" in parsed) {
    out.disabled.push({ name: parsed.stub.name, agent: parsed.stub.agent, origin });
    return;
  }
  if (!parsed.enabled) {
    out.disabled.push({ name: parsed.job.name, agent: parsed.job.agent, origin });
    return;
  }
  const reason = check?.(parsed.job);
  if (reason !== undefined) {
    out.dropped.push({ name: parsed.job.name, layer: origin.layer, reason });
    return;
  }
  out.jobs.push(parsed.job);
  out.origins.set(parsed.job.name, origin);
}

export type NimbusFleetLoad = { config: NimbusFleetToml } & FleetJobsResolved;

/**
 * The one `[fleet]` core. `raw === null` means no file.
 *
 * A malformed `[fleet]` TABLE throws rather than falling back to defaults. The CALLER
 * (`platform/assemble.ts`) catches, logs loudly and constructs no scheduler — so the gateway still
 * boots and the fleet is off. Crashing boot over an optional, default-off feature is
 * disproportionate; silently running a half-read config is worse. The refusal is recorded through
 * `onFallback` first, so `config explain` can report it. A bad JOB drops only itself, into
 * `dropped`, through `resolveFleetJobs`.
 */
function loadNimbusFleetFromText(
  raw: string | null,
  sections: () => readonly EffectiveSection[],
  check: FleetJobChecker | undefined,
  onFallback?: SectionFallbackSink,
): NimbusFleetLoad {
  if (raw === null) {
    return {
      config: DEFAULT_FLEET_CONFIG,
      jobs: [],
      origins: new Map(),
      disabled: [],
      dropped: [],
    };
  }
  let config: NimbusFleetToml;
  try {
    config = parseNimbusTomlFleet(raw);
  } catch (err) {
    onFallback?.(`refused: ${fallbackMessage(err)}`);
    throw err;
  }
  return { config, ...resolveFleetJobs(sections(), check) };
}

/** Single-file reader (tests). Production reads `loadNimbusFleetFromConfigDir`. */
export function loadNimbusFleetFromPath(
  tomlPath: string,
  check?: FleetJobChecker,
): NimbusFleetLoad {
  const text = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : null;
  return loadNimbusFleetFromText(
    text,
    () =>
      mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: tomlPath }, text ?? "")])
        .sections,
    check,
  );
}

/** `[fleet]` over the layered snapshot (packs, base, active profile). Throws like the path door. */
export function loadNimbusFleetFromConfigDir(
  configDir: string,
  check?: FleetJobChecker,
): NimbusFleetLoad {
  const readError = layerReadError(configDir);
  if (readError !== undefined) {
    sectionFallbackSink(configDir, "fleet")(`refused: ${readError}`);
    throw new Error(readError);
  }
  const snapshot = getLayeredConfig(configDir).snapshot();
  return loadNimbusFleetFromText(
    snapshot.text,
    () => snapshot.doc.sections,
    check,
    sectionFallbackSink(configDir, "fleet"),
  );
}

export { parseBool };
