import { isValidTimeZone, machineTimeZone, scheduleRefusal } from "../automation/cron.ts";
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseBool,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[iac.drift]` - the owner's scheduled Terraform drift check (Phase 10 IaC drift D2, owner ruling
 * OR-DRIFT-2). DEFAULT OFF: with no valid `schedule` nothing runs unattended. `schedule` is a five-field
 * cron expression (`automation/cron.ts`, no schedule under five minutes) in `tz` (default: the machine's
 * zone); `notify` (default true) lets a scheduled run raise a local OS notification when a workdir's drift
 * appears or changes. A malformed value is a fallback to that key's default, reported through
 * `sectionFallbackSink` so `nimbus config explain` names it; an invalid schedule turns the schedule off.
 */
export type NimbusIacDriftToml = {
  /** The cron expression, or `undefined` (off). */
  readonly schedule: string | undefined;
  readonly tz: string;
  readonly notify: boolean;
};

export function defaultIacDriftConfig(): NimbusIacDriftToml {
  return Object.freeze({ schedule: undefined, tz: machineTimeZone(), notify: true });
}

type Draft = { -readonly [K in keyof NimbusIacDriftToml]: NimbusIacDriftToml[K] };

/** The key-value pairs of the `[iac.drift]` table, in order. */
function sectionPairs(source: string): Array<{ key: string; valRaw: string }> {
  const pairs: Array<{ key: string; valRaw: string }> = [];
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (isTableHeader(trimmed)) inSection = trimmed === "[iac.drift]";
    else if (inSection && trimmed !== "") {
      const kv = splitKeyValue(trimmed);
      if (kv !== undefined) pairs.push(kv);
    }
  }
  return pairs;
}

/** Applies `tz` or `notify` to `out`; a bad value keeps the default and is reported. */
function applyKey(out: Draft, key: string, valRaw: string, report: (m: string) => void): void {
  if (key === "tz") {
    const tz = parseString(valRaw);
    if (isValidTimeZone(tz)) out.tz = tz;
    else report(`[iac.drift].tz is not a time zone (got: ${valRaw}); using ${out.tz}`);
  } else if (key === "notify") {
    const b = parseBool(valRaw);
    if (b === undefined)
      report(`[iac.drift].notify must be true or false (got: ${valRaw}); using true`);
    else out.notify = b;
  }
}

export function parseNimbusTomlIacDrift(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIacDriftToml {
  const out: Draft = { ...defaultIacDriftConfig() };
  const report = (m: string): void => onFallback?.(m);
  let rawSchedule: string | undefined;
  for (const { key, valRaw } of sectionPairs(source)) {
    if (key === "schedule") rawSchedule = parseString(valRaw);
    else applyKey(out, key, valRaw, report);
  }
  if (rawSchedule !== undefined) {
    const refusal = scheduleRefusal(rawSchedule, out.tz);
    if (refusal === undefined) out.schedule = rawSchedule;
    else report(`[iac.drift].schedule is not used (${refusal}); the scheduled drift check is off`);
  }
  return Object.freeze(out);
}

/** `[iac.drift]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusIacDriftFromConfigDir(configDir: string): NimbusIacDriftToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return defaultIacDriftConfig();
  return parseNimbusTomlIacDrift(raw, sectionFallbackSink(configDir, "iac.drift"));
}
