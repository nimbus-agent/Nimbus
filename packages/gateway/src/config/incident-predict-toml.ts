import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseIntDec,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * The incident engine's predictions (Phase 10 IC8, incident-engine spec § 5.8): `[incident] anomaly_z` and the
 * `[[incident.expect]]` entries the radar checks. `[incident]`'s other keys are `incident-toml.ts`'s; this module
 * reads only these two, so neither parser has to know the other's keys.
 *
 * `[[incident.expect]]`:
 * - `kind = "deploy" | "ci_success"`: `service` is a `[ci.service.<id>]` id; the last successful deployment, or the
 *   newest successful CI run bound to that service.
 * - `kind = "sync"`: `service` is a connector id; its last sync that recorded no error.
 * - `kind = "item"`: `service` is the connector service and `type` the item type; the newest such item.
 * - `max_gap`: `<n>m`, `<n>h` or `<n>d`, from 15 minutes to 30 days.
 * An entry with a missing or bad field is skipped and reported through `onFallback`; boot never aborts. A second
 * entry with the same kind, service and type is a duplicate and skipped. At most {@link MAX_EXPECTATIONS}.
 *
 * `[incident] anomaly_z` (default 3, `3..20`): the z-score at or above which a bucket is a finding. Out of range
 * is a fallback to the default, never clamped.
 */

export type ExpectationKind = "deploy" | "ci_success" | "sync" | "item";

export type Expectation = {
  /** `<kind>:<service>` or `item:<service>:<type>`: the radar finding's key. */
  readonly key: string;
  readonly kind: ExpectationKind;
  readonly service: string;
  readonly type: string | null;
  readonly maxGapMs: number;
};

export type NimbusIncidentPredictToml = {
  readonly anomalyZ: number;
  readonly expectations: readonly Expectation[];
};

export const ANOMALY_Z_MIN = 3;
export const ANOMALY_Z_MAX = 20;
export const MAX_EXPECTATIONS = 100;
export const MIN_GAP_MS = 15 * 60_000;
export const MAX_GAP_MS = 30 * 86_400_000;

export const DEFAULT_INCIDENT_PREDICT: NimbusIncidentPredictToml = Object.freeze({
  anomalyZ: 3,
  expectations: Object.freeze([]) as readonly Expectation[],
});

const KINDS: readonly ExpectationKind[] = ["deploy", "ci_success", "sync", "item"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const UNIT_MS: Readonly<Record<string, number>> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** `15m`, `6h`, `2d` to milliseconds; undefined for anything else or out of range. */
export function parseMaxGap(raw: string): number | undefined {
  const m = /^(\d{1,5})([mhd])$/.exec(raw);
  if (m === null) return undefined;
  const ms = Number(m[1]) * (UNIT_MS[m[2] as string] as number);
  return ms >= MIN_GAP_MS && ms <= MAX_GAP_MS ? ms : undefined;
}

type Draft = {
  kind?: string | undefined;
  service?: string | undefined;
  type?: string | undefined;
  maxGap?: string | undefined;
};

function stringValue(raw: string): string | undefined {
  try {
    return parseString(raw);
  } catch {
    return undefined;
  }
}

function finish(
  d: Draft,
  index: number,
  seen: Set<string>,
  out: Expectation[],
  onFallback: SectionFallbackSink | undefined,
): void {
  const where = `[[incident.expect]] #${String(index)}`;
  const skip = (why: string): void => onFallback?.(`${where} skipped: ${why}`);
  const kind = KINDS.find((k) => k === d.kind);
  if (kind === undefined) return skip(`kind must be one of ${KINDS.join(", ")}`);
  if (d.service === undefined || !NAME_RE.test(d.service))
    return skip("service is missing or invalid");
  let type: string | null = null;
  if (kind === "item") {
    if (d.type === undefined || !NAME_RE.test(d.type))
      return skip("an item expectation needs a type");
    type = d.type;
  } else if (d.type !== undefined) {
    return skip('type is only for kind = "item"');
  }
  const maxGapMs = d.maxGap === undefined ? undefined : parseMaxGap(d.maxGap);
  if (maxGapMs === undefined) return skip("max_gap must be <n>m, <n>h or <n>d, 15m to 30d");
  const key = type === null ? `${kind}:${d.service}` : `item:${d.service}:${type}`;
  if (seen.has(key)) return skip(`duplicate of an earlier ${key}`);
  if (out.length >= MAX_EXPECTATIONS) return skip(`more than ${String(MAX_EXPECTATIONS)} entries`);
  seen.add(key);
  out.push(Object.freeze({ key, kind, service: d.service, type, maxGapMs }));
}

function anomalyZOf(raw: string, onFallback: SectionFallbackSink | undefined): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= ANOMALY_Z_MIN && n <= ANOMALY_Z_MAX) return n;
  onFallback?.(
    `[incident].anomaly_z must be an integer ${String(ANOMALY_Z_MIN)}..${String(ANOMALY_Z_MAX)} (got: ${raw}); using ${String(DEFAULT_INCIDENT_PREDICT.anomalyZ)}`,
  );
  return DEFAULT_INCIDENT_PREDICT.anomalyZ;
}

export function parseNimbusTomlIncidentPredict(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusIncidentPredictToml {
  let anomalyZ = DEFAULT_INCIDENT_PREDICT.anomalyZ;
  const out: Expectation[] = [];
  const seen = new Set<string>();
  let section: "incident" | "expect" | null = null;
  let draft: Draft | null = null;
  let index = 0;
  const flush = (): void => {
    if (draft !== null) finish(draft, index, seen, out, onFallback);
    draft = null;
  };
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (trimmed === "[[incident.expect]]") {
      flush();
      index += 1;
      draft = {};
      section = "expect";
      continue;
    }
    if (isTableHeader(trimmed)) {
      flush();
      section = trimmed === "[incident]" ? "incident" : null;
      continue;
    }
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    if (section === "incident" && kv.key === "anomaly_z") {
      anomalyZ = anomalyZOf(kv.valRaw, onFallback);
    } else if (section === "expect" && draft !== null) {
      const v = stringValue(kv.valRaw);
      if (kv.key === "kind") draft.kind = v;
      else if (kv.key === "service") draft.service = v;
      else if (kv.key === "type") draft.type = v;
      else if (kv.key === "max_gap") draft.maxGap = v;
    }
  }
  flush();
  return Object.freeze({ anomalyZ, expectations: Object.freeze(out) });
}

/** Over the layered snapshot (packs, base, active profile); read per call so an edit applies without a restart. */
export function loadNimbusIncidentPredictFromConfigDir(
  configDir: string,
): NimbusIncidentPredictToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_INCIDENT_PREDICT;
  return parseNimbusTomlIncidentPredict(raw, sectionFallbackSink(configDir, "incident.expect"));
}
