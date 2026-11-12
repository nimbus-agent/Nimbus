import { isValidTimeZone, machineTimeZone, scheduleRefusal } from "../automation/cron.ts";
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[briefing]` and `[briefing.deadlines]` - the morning briefing (Phase 10, spec
 * 2026-11-11-morning-briefing.md). MB1 reads `snapshot_interval_minutes` (how often a syncable may
 * refresh its "my open work" snapshot); MB5 reads the rest: the schedule, the zone, the sections, the
 * retention and the 24-hour deadline notices.
 *
 * A value out of range or malformed is a section fallback to THAT KEY's default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped and it never condemns
 * another key. `tz: null` means "the machine's zone", resolved at use by {@link effectiveBriefingZone}
 * so the frozen default is not machine-dependent.
 */
export const BRIEFING_SECTIONS = [
  "calendar",
  "oncall",
  "incidents",
  "reviews",
  "tickets",
  "mail",
  "chat",
] as const;
export type BriefingSection = (typeof BRIEFING_SECTIONS)[number];

export type NimbusBriefingDeadlinesToml = {
  readonly enabled: boolean;
  readonly leadHours: number;
  readonly quietHours: number;
};

export type NimbusBriefingToml = {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly tz: string | null;
  readonly sections: readonly BriefingSection[];
  readonly retentionDays: number;
  readonly snapshotIntervalMinutes: number;
  readonly deadlines: NimbusBriefingDeadlinesToml;
};

export const BRIEFING_SNAPSHOT_INTERVAL_MIN = 5;
export const BRIEFING_SNAPSHOT_INTERVAL_MAX = 240;
export const BRIEFING_RETENTION_MIN = 1;
export const BRIEFING_RETENTION_MAX = 365;
export const BRIEFING_LEAD_HOURS_MIN = 1;
export const BRIEFING_LEAD_HOURS_MAX = 168;
export const BRIEFING_QUIET_HOURS_MIN = 1;
export const BRIEFING_QUIET_HOURS_MAX = 336;
/** The briefing may not fire more often than this (minutes). */
export const BRIEFING_MIN_INTERVAL_MINUTES = 60;

export const DEFAULT_BRIEFING_CONFIG: NimbusBriefingToml = Object.freeze({
  enabled: false,
  schedule: "30 8 * * 1-5",
  tz: null,
  sections: Object.freeze([...BRIEFING_SECTIONS]) as readonly BriefingSection[],
  retentionDays: 30,
  snapshotIntervalMinutes: 15,
  deadlines: Object.freeze({ enabled: false, leadHours: 24, quietHours: 24 }),
});

/** The zone the briefing runs in: the configured one, else the machine's. */
export function effectiveBriefingZone(cfg: Pick<NimbusBriefingToml, "tz">): string {
  return cfg.tz ?? machineTimeZone();
}

type Draft = {
  -readonly [K in keyof NimbusBriefingToml]: NimbusBriefingToml[K];
};
type DeadlinesDraft = {
  -readonly [K in keyof NimbusBriefingDeadlinesToml]: NimbusBriefingDeadlinesToml[K];
};

type Report = (msg: string) => void;

function isSection(v: string): v is BriefingSection {
  return (BRIEFING_SECTIONS as readonly string[]).includes(v);
}

/** An integer key in `min..max`, else the default (reported). */
function intInRange(
  raw: string,
  min: number,
  max: number,
  label: string,
  fallback: number,
  report: Report,
): number {
  const n = parseIntDec(raw);
  if (n !== undefined && n >= min && n <= max) return n;
  report(
    `${label} must be an integer ${String(min)}..${String(max)} (got: ${raw}); using ${String(fallback)}`,
  );
  return fallback;
}

function boolKey(raw: string, label: string, fallback: boolean, report: Report): boolean {
  const b = parseBool(raw);
  if (b !== undefined) return b;
  report(`${label} must be true or false (got: ${raw}); using ${String(fallback)}`);
  return fallback;
}

function sectionsKey(raw: string, report: Report): readonly BriefingSection[] {
  const fallback = DEFAULT_BRIEFING_CONFIG.sections;
  let values: string[];
  try {
    // `parseStringArray` THROWS on a non-array value and on a multi-line array (this line parser
    // sees a bare `[`), so an unparseable value is a fallback, not a boot failure.
    values = parseStringArray(raw);
    // `parseStringArray` silently drops empty entries; here an empty or doubled-comma entry is a
    // malformed key, not a shorter list. One trailing comma is valid TOML and stays accepted.
    const inner = raw.trim().slice(1, -1).trim();
    if (inner !== "") {
      const parts = inner.split(",");
      if (parts.length > 1 && (parts.at(-1) ?? "").trim() === "") parts.pop();
      if (parts.some((p) => parseString(p) === "")) {
        report("[briefing].sections holds an empty entry; using all");
        return fallback;
      }
    }
  } catch {
    report(
      `[briefing].sections must be a one-line array of section names (got: ${raw}); using all`,
    );
    return fallback;
  }
  const out: BriefingSection[] = [];
  for (const v of values) {
    if (!isSection(v) || out.includes(v)) {
      report(
        `[briefing].sections holds an unknown or repeated name "${v}" (allowed: ${BRIEFING_SECTIONS.join(", ")}); using all`,
      );
      return fallback;
    }
    out.push(v);
  }
  if (out.length === 0) {
    report("[briefing].sections must name at least one section; using all");
    return fallback;
  }
  return out;
}

function applyMainKey(draft: Draft, key: string, valRaw: string, report: Report): void {
  switch (key) {
    case "enabled":
      draft.enabled = boolKey(valRaw, "[briefing].enabled", false, report);
      break;
    case "schedule":
      draft.schedule = parseString(valRaw);
      break;
    case "tz": {
      const tz = parseString(valRaw);
      if (isValidTimeZone(tz)) {
        draft.tz = tz;
      } else {
        draft.tz = null;
        report(`[briefing].tz must be an IANA time zone (got: ${valRaw}); using the machine zone`);
      }
      break;
    }
    case "sections":
      draft.sections = sectionsKey(valRaw, report);
      break;
    case "retention_days":
      draft.retentionDays = intInRange(
        valRaw,
        BRIEFING_RETENTION_MIN,
        BRIEFING_RETENTION_MAX,
        "[briefing].retention_days",
        DEFAULT_BRIEFING_CONFIG.retentionDays,
        report,
      );
      break;
    case "snapshot_interval_minutes":
      draft.snapshotIntervalMinutes = intInRange(
        valRaw,
        BRIEFING_SNAPSHOT_INTERVAL_MIN,
        BRIEFING_SNAPSHOT_INTERVAL_MAX,
        "[briefing].snapshot_interval_minutes",
        DEFAULT_BRIEFING_CONFIG.snapshotIntervalMinutes,
        report,
      );
      break;
    default:
      break;
  }
}

function applyDeadlinesKey(
  draft: DeadlinesDraft,
  key: string,
  valRaw: string,
  report: Report,
): void {
  const defaults = DEFAULT_BRIEFING_CONFIG.deadlines;
  switch (key) {
    case "enabled":
      draft.enabled = boolKey(valRaw, "[briefing.deadlines].enabled", false, report);
      break;
    case "lead_hours":
      draft.leadHours = intInRange(
        valRaw,
        BRIEFING_LEAD_HOURS_MIN,
        BRIEFING_LEAD_HOURS_MAX,
        "[briefing.deadlines].lead_hours",
        defaults.leadHours,
        report,
      );
      break;
    case "quiet_hours":
      draft.quietHours = intInRange(
        valRaw,
        BRIEFING_QUIET_HOURS_MIN,
        BRIEFING_QUIET_HOURS_MAX,
        "[briefing.deadlines].quiet_hours",
        defaults.quietHours,
        report,
      );
      break;
    default:
      break;
  }
}

function tableOfHeader(header: string): "main" | "deadlines" | null {
  if (header === "[briefing]") return "main";
  if (header === "[briefing.deadlines]") return "deadlines";
  return null;
}

/** The schedule is validated against the EFFECTIVE zone, so a bad `tz` does not also condemn it. */
function validateScheduleDraft(draft: Draft, report: Report): void {
  const refusal = scheduleRefusal(
    draft.schedule,
    effectiveBriefingZone(draft),
    BRIEFING_MIN_INTERVAL_MINUTES,
  );
  if (refusal === undefined) return;
  report(
    `[briefing].schedule "${draft.schedule}" is not usable (${refusal}); using "${DEFAULT_BRIEFING_CONFIG.schedule}"`,
  );
  draft.schedule = DEFAULT_BRIEFING_CONFIG.schedule;
}

/** Parse `[briefing]` and `[briefing.deadlines]`. A bad value reports through `onFallback`. */
export function parseNimbusTomlBriefing(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusBriefingToml {
  const report: Report = (msg) => onFallback?.(msg);
  const draft: Draft = { ...DEFAULT_BRIEFING_CONFIG };
  const deadlines: DeadlinesDraft = { ...DEFAULT_BRIEFING_CONFIG.deadlines };
  let table: "main" | "deadlines" | null = null;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      table = tableOfHeader(trimmed);
      continue;
    }
    if (table === null) continue;
    const kv = splitKeyValue(trimmed);
    if (kv === undefined) continue;
    if (table === "main") applyMainKey(draft, kv.key, kv.valRaw, report);
    else applyDeadlinesKey(deadlines, kv.key, kv.valRaw, report);
  }
  validateScheduleDraft(draft, report);
  return Object.freeze({
    ...draft,
    sections: Object.freeze([...draft.sections]),
    deadlines: Object.freeze({ ...deadlines }),
  });
}

/** `[briefing]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusBriefingFromConfigDir(configDir: string): NimbusBriefingToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_BRIEFING_CONFIG;
  return parseNimbusTomlBriefing(raw, sectionFallbackSink(configDir, "briefing"));
}
