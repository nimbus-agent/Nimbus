import { existsSync, readFileSync } from "node:fs";
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

export interface NimbusFleetJobToml {
  readonly name: string;
  readonly agent: string;
  readonly intervalSeconds: number;
  readonly params: Readonly<Record<string, FleetJobParamValue>>;
  readonly digestMinDelta: number;
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

const JOB_RESERVED = new Set(["name", "agent", "interval_seconds", "digest_min_delta"]);

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

/** One `[[fleet.job]]` block as it accumulates, before `flush` validates it into a job. */
type FleetJobDraft = {
  name?: string;
  agent?: string;
  intervalSeconds?: number;
  params: Record<string, FleetJobParamValue>;
  digestMinDelta?: number;
};

/**
 * Apply one `[[fleet.job]]` key to the block being accumulated. A malformed value is ignored and
 * left for `flush` to refuse as missing; `digest_min_delta` is the one key that throws on a value
 * it CAN read but must not accept.
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
    const n = parseIntDec(valRaw);
    if (n !== undefined) cur.intervalSeconds = n;
    return;
  }
  if (key === "digest_min_delta") {
    const n = parseIntDec(valRaw);
    if (n === undefined) return;
    // Refused below 1, and NOT for `retention_days`' reason. A zero admits every metric whose
    // absolute delta is >= 0 — that is, every metric, including ones that did not move — so it
    // turns the threshold inside out and reports MORE than no threshold at all. There is no
    // reading of it that means what someone writing it would intend.
    if (n < 1) {
      // Named the same way every sibling refusal in this parser does (`${name} requires agent`,
      // `${name} requires interval_seconds > 0`): `cur.name` is whatever has been parsed so far in
      // THIS block, so it is present whenever `name` precedes `digest_min_delta` in the file — the
      // ordinary case, and the one every example in this repo's own docs uses. A
      // `digest_min_delta` line written before `name` still throws, just without a name to show;
      // that is a parser-order limitation, not a silent bug.
      throw new FleetConfigError(
        `[[fleet.job]] ${cur.name ?? "(unnamed)"} digest_min_delta must be >= 1 ` +
          `(got ${String(n)}); a zero would report every metric, including unchanged ones`,
      );
    }
    cur.digestMinDelta = n;
    return;
  }
  if (!JOB_RESERVED.has(key)) {
    const n = parseIntDec(valRaw);
    cur.params[camel(key)] = n ?? parseString(valRaw);
  }
}

export function parseNimbusTomlFleetJobs(source: string): NimbusFleetJobToml[] {
  const jobs: NimbusFleetJobToml[] = [];
  const seen = new Set<string>();
  let cur: FleetJobDraft | undefined;

  const flush = (): void => {
    if (cur === undefined) return;
    const { name, agent, intervalSeconds, params, digestMinDelta } = cur;
    cur = undefined;
    // A block with nothing in it is not a job; an INCOMPLETE one is a job the owner meant to
    // configure. Refuse the second rather than dropping it (they would believe it runs) or
    // defaulting it (a schedule they did not choose).
    if (name === undefined && agent === undefined && intervalSeconds === undefined) return;
    if (name === undefined) throw new FleetConfigError("[[fleet.job]] requires name");
    if (agent === undefined) throw new FleetConfigError(`[[fleet.job]] ${name} requires agent`);
    if (intervalSeconds === undefined || intervalSeconds <= 0) {
      throw new FleetConfigError(`[[fleet.job]] ${name} requires interval_seconds > 0`);
    }
    if (seen.has(name)) {
      throw new FleetConfigError(`[[fleet.job]] duplicate name: ${name}`);
    }
    seen.add(name);
    jobs.push({ name, agent, intervalSeconds, params, digestMinDelta: digestMinDelta ?? 1 });
  };

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      flush();
      if (trimmed === "[[fleet.job]]") cur = { params: {} };
      continue;
    }
    if (cur === undefined) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    applyJobKey(cur, kv.key, kv.valRaw);
  }
  flush();
  return jobs;
}

/**
 * Takes a PATH, not a config dir — and there is deliberately no `…FromConfigDir` variant.
 *
 * `config/nimbus-toml.ts`'s `loadNimbusAgentsFromPath` carries the reason in its own comment: the
 * former `loadNimbusAgentsFromConfigDir` hardcoded `nimbus.toml`, was therefore profile-BLIND, and
 * silently discarded `[agents] synthesis` set in a profile TOML. That variant was DELETED rather
 * than left exported beside the profile-aware one "for someone to reach for by accident". Exporting
 * a config-dir loader here would be reaching for it.
 *
 * Callers pass `resolveNimbusTomlForProfile(configDir)`.
 *
 * A malformed block THROWS rather than falling back to defaults. The CALLER
 * (`platform/assemble.ts`) catches, logs loudly and constructs no scheduler — so the gateway still
 * boots and the fleet is off. Crashing boot over an optional, default-off feature is
 * disproportionate; silently running a half-read config is worse.
 */
export function loadNimbusFleetFromPath(tomlPath: string): {
  config: NimbusFleetToml;
  jobs: NimbusFleetJobToml[];
} {
  if (!existsSync(tomlPath)) return { config: DEFAULT_FLEET_CONFIG, jobs: [] };
  const raw = readFileSync(tomlPath, "utf8");
  return { config: parseNimbusTomlFleet(raw), jobs: parseNimbusTomlFleetJobs(raw) };
}

export { parseBool };
