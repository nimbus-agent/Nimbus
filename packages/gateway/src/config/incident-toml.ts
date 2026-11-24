import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[incident]` - the incident engine (Phase 10 IC3, incident-engine spec § 5.3). This section decides what is
 * ASSEMBLED; `[oncall.push]` decides what is PUSHED, and neither reads the other's severity set.
 *
 * - `enabled` (default `true`): `false` turns off ONLY the automatic assembly after a sync. On-demand
 *   assembly (`nimbus incident show`, `incident.assemble`), the push's own assembly of its candidates, the
 *   reads, retention and erasure keep working, so a page is never dropped.
 * - `severities` (default empty = the per-source defaults): a NON-EMPTY list REPLACES the defaults for every
 *   source, lower-cased and de-duplicated.
 * - `bigeye_sla_statuses` (default empty): Bigeye `slaStatus` values (lower-cased) that make a Bigeye item
 *   trigger. Bigeye has no severity, so it never auto-triggers without this.
 * - `data_schema_lookback_hours` (default 24, `1..168`): how far BEFORE a data incident's open time the data lane
 *   looks for warehouse schema changes of the monitored tables (the window also runs to the assembly time, at
 *   most 24 hours after the open time).
 * - `retention_days` (default 365, `7..3650`) and `lookback_days` (default 7, `1..90`): out of range is a
 *   section fallback to the default, recorded through `sectionFallbackSink`, never clamped.
 *
 * `[incident.*]` sub-tables, `[[incident.expect]]` and `anomaly_z` are ignored here: `incident-predict-toml.ts` reads them (IC8).
 */
export type NimbusIncidentToml = {
  readonly enabled: boolean;
  readonly severities: readonly string[];
  readonly bigeyeSlaStatuses: readonly string[];
  readonly retentionDays: number;
  readonly lookbackDays: number;
  readonly dataSchemaLookbackHours: number;
};

export const INCIDENT_RETENTION_MIN = 7;
export const INCIDENT_RETENTION_MAX = 3650;
export const INCIDENT_LOOKBACK_MIN = 1;
export const INCIDENT_LOOKBACK_MAX = 90;
export const INCIDENT_SCHEMA_LOOKBACK_MIN = 1;
export const INCIDENT_SCHEMA_LOOKBACK_MAX = 168;

export const DEFAULT_INCIDENT_CONFIG: NimbusIncidentToml = Object.freeze({
  enabled: true,
  severities: Object.freeze([]) as readonly string[],
  bigeyeSlaStatuses: Object.freeze([]) as readonly string[],
  retentionDays: 365,
  lookbackDays: 7,
  dataSchemaLookbackHours: 24,
});

type IncidentDraft = { -readonly [K in keyof NimbusIncidentToml]: NimbusIncidentToml[K] };

function lowerDeduped(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const lower = v.trim().toLowerCase();
    if (lower === "" || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

function boundedOrDefault(
  key: string,
  raw: string,
  range: readonly [number, number],
  fallback: number,
  onFallback: SectionFallbackSink | undefined,
): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= range[0] && n <= range[1]) return n;
  onFallback?.(
    `[incident].${key} must be an integer ${String(range[0])}..${String(range[1])} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

/** A list value; a non-array or multi-line value is ignored so the value in effect stands (boot never aborts). */
function listOrKeep(raw: string, current: readonly string[]): readonly string[] {
  try {
    return lowerDeduped(parseStringArray(raw));
  } catch {
    return current;
  }
}

function applyIncidentKey(
  out: IncidentDraft,
  key: string,
  valRaw: string,
  onFallback: SectionFallbackSink | undefined,
): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "severities":
      out.severities = listOrKeep(valRaw, out.severities);
      break;
    case "bigeye_sla_statuses":
      out.bigeyeSlaStatuses = listOrKeep(valRaw, out.bigeyeSlaStatuses);
      break;
    case "retention_days":
      out.retentionDays = boundedOrDefault(
        key,
        valRaw,
        [INCIDENT_RETENTION_MIN, INCIDENT_RETENTION_MAX],
        DEFAULT_INCIDENT_CONFIG.retentionDays,
        onFallback,
      );
      break;
    case "lookback_days":
      out.lookbackDays = boundedOrDefault(
        key,
        valRaw,
        [INCIDENT_LOOKBACK_MIN, INCIDENT_LOOKBACK_MAX],
        DEFAULT_INCIDENT_CONFIG.lookbackDays,
        onFallback,
      );
      break;
    case "data_schema_lookback_hours":
      out.dataSchemaLookbackHours = boundedOrDefault(
        key,
        valRaw,
        [INCIDENT_SCHEMA_LOOKBACK_MIN, INCIDENT_SCHEMA_LOOKBACK_MAX],
        DEFAULT_INCIDENT_CONFIG.dataSchemaLookbackHours,
        onFallback,
      );
      break;
    default:
      break;
  }
}

/** Parse `[incident]`. A bad value reports through `onFallback`. `[incident.*]` sub-tables are ignored. */
export function parseNimbusTomlIncident(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIncidentToml {
  const out: IncidentDraft = { ...DEFAULT_INCIDENT_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[incident]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyIncidentKey(out, kv.key, kv.valRaw, onFallback);
  }
  return Object.freeze(out);
}

/** `[incident]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusIncidentFromConfigDir(configDir: string): NimbusIncidentToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_INCIDENT_CONFIG;
  return parseNimbusTomlIncident(raw, sectionFallbackSink(configDir, "incident"));
}
