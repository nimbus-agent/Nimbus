import { isValidTimeZone, machineTimeZone } from "../automation/cron.ts";
import {
  layeredConfigText,
  type SectionFallbackSink,
  sectionFallbackSink,
} from "./layered-config.ts";
import {
  isTableHeader,
  parseString,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/**
 * `[preflight.risk]`: the advisory deploy-risk block of `nimbus deploy preflight` (Phase 17).
 *
 *   quiet_days  = ["sat", "sun"]          # whole days flagged (mon..sun)
 *   quiet_hours = ["fri 15:00-24:00"]     # "<day> HH:MM-HH:MM" windows, end up to 24:00, no midnight crossing
 *   tz          = "Europe/Berlin"         # the zone the two keys above are read in; absent = the machine's zone
 *   fail_at     = "high"                  # "elevated" | "high"; absent = the risk NEVER changes the verdict
 *
 * A value malformed or out of range is a section fallback to THAT KEY's default, recorded through
 * `sectionFallbackSink` so `nimbus config explain` names it; it is never clamped and it never condemns
 * another key. An empty array is valid and means "no quiet days" / "no quiet windows".
 */
export const RISK_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type RiskDay = (typeof RISK_DAYS)[number];

export type RiskFailAt = "elevated" | "high";

export type QuietWindow = {
  /** 0 = Sunday .. 6 = Saturday, as `Date#getUTCDay` numbers them. */
  readonly day: number;
  readonly startMinute: number;
  readonly endMinute: number;
  /** The entry as written (lower-cased, canonical spacing), for evidence lines. */
  readonly label: string;
};

export type NimbusPreflightRiskToml = {
  readonly quietDays: readonly number[];
  readonly quietHours: readonly QuietWindow[];
  readonly tz: string | null;
  readonly failAt: RiskFailAt | null;
};

const DEFAULT_QUIET_HOURS_TEXT = ["fri 15:00-24:00"] as const;
const DEFAULT_QUIET_DAYS_TEXT = ["sat", "sun"] as const;

const WINDOW_PATTERN = /^([a-z]{3})\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

function dayIndex(name: string): number {
  return (RISK_DAYS as readonly string[]).indexOf(name);
}

/** One `quiet_hours` entry, or null when it is malformed. */
export function parseQuietWindow(entry: string): QuietWindow | null {
  const m = WINDOW_PATTERN.exec(entry.trim().toLowerCase());
  if (m === null) return null;
  const day = dayIndex(m[1] as string);
  const sh = Number(m[2]);
  const sm = Number(m[3]);
  const eh = Number(m[4]);
  const em = Number(m[5]);
  if (day < 0 || sm > 59 || em > 59 || sh > 24 || eh > 24) return null;
  const startMinute = sh * 60 + sm;
  const endMinute = eh * 60 + em;
  if (startMinute >= endMinute || startMinute >= 24 * 60 || endMinute > 24 * 60) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return {
    day,
    startMinute,
    endMinute,
    label: `${RISK_DAYS[day] as string} ${pad(sh)}:${pad(sm)}-${pad(eh)}:${pad(em)}`,
  };
}

function defaultQuietHours(): readonly QuietWindow[] {
  return Object.freeze(
    DEFAULT_QUIET_HOURS_TEXT.map((e) => Object.freeze(parseQuietWindow(e) as QuietWindow)),
  );
}

export const DEFAULT_PREFLIGHT_RISK_CONFIG: NimbusPreflightRiskToml = Object.freeze({
  quietDays: Object.freeze(DEFAULT_QUIET_DAYS_TEXT.map(dayIndex)),
  quietHours: defaultQuietHours(),
  tz: null,
  failAt: null,
});

/** The zone the quiet windows are read in: the configured one, else the machine's. */
export function effectivePreflightRiskZone(cfg: Pick<NimbusPreflightRiskToml, "tz">): string {
  return cfg.tz ?? machineTimeZone();
}

type Report = (msg: string) => void;
type Draft = { -readonly [K in keyof NimbusPreflightRiskToml]: NimbusPreflightRiskToml[K] };

/** A one-line array of strings, or null when it does not parse (reported by the caller). */
function stringList(raw: string): string[] | null {
  try {
    const values = parseStringArray(raw);
    const inner = raw.trim().slice(1, -1).trim();
    if (inner === "") return values;
    const parts = inner.split(",");
    if (parts.length > 1 && (parts.at(-1) ?? "").trim() === "") parts.pop();
    return parts.some((p) => parseString(p) === "") ? null : values;
  } catch {
    return null;
  }
}

function quietDaysKey(raw: string, report: Report): readonly number[] {
  const values = stringList(raw);
  const days = values?.map((v) => dayIndex(v.trim().toLowerCase()));
  if (values === null || days === undefined || days.some((d) => d < 0)) {
    report(
      `[preflight.risk].quiet_days must be a one-line array of ${RISK_DAYS.join(", ")} (got: ${raw}); using ${DEFAULT_QUIET_DAYS_TEXT.join(", ")}`,
    );
    return DEFAULT_PREFLIGHT_RISK_CONFIG.quietDays;
  }
  return Object.freeze([...new Set(days)]);
}

function quietHoursKey(raw: string, report: Report): readonly QuietWindow[] {
  const values = stringList(raw);
  const windows = values?.map(parseQuietWindow);
  if (values === null || windows === undefined || windows.includes(null)) {
    report(
      `[preflight.risk].quiet_hours must be a one-line array of "<day> HH:MM-HH:MM" windows with the end after the start and no later than 24:00 (got: ${raw}); using ${DEFAULT_QUIET_HOURS_TEXT.join(", ")}`,
    );
    return DEFAULT_PREFLIGHT_RISK_CONFIG.quietHours;
  }
  return Object.freeze((windows as QuietWindow[]).map((w) => Object.freeze(w)));
}

function applyKey(draft: Draft, key: string, valRaw: string, report: Report): void {
  switch (key) {
    case "quiet_days":
      draft.quietDays = quietDaysKey(valRaw, report);
      break;
    case "quiet_hours":
      draft.quietHours = quietHoursKey(valRaw, report);
      break;
    case "tz": {
      const tz = parseString(valRaw);
      if (isValidTimeZone(tz)) {
        draft.tz = tz;
      } else {
        draft.tz = null;
        report(
          `[preflight.risk].tz must be an IANA time zone (got: ${valRaw}); using the machine zone`,
        );
      }
      break;
    }
    case "fail_at": {
      const v = parseString(valRaw);
      if (v === "elevated" || v === "high") {
        draft.failAt = v;
      } else {
        draft.failAt = null;
        report(
          `[preflight.risk].fail_at must be "elevated" or "high" (got: ${valRaw}); the risk will not change the verdict`,
        );
      }
      break;
    }
    default:
      break;
  }
}

/** Parse `[preflight.risk]`. A bad value reports through `onFallback`. */
export function parseNimbusTomlPreflightRisk(
  source: string,
  onFallback?: SectionFallbackSink,
): NimbusPreflightRiskToml {
  const report: Report = (msg) => onFallback?.(msg);
  const draft: Draft = { ...DEFAULT_PREFLIGHT_RISK_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[preflight.risk]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyKey(draft, kv.key, kv.valRaw, report);
  }
  return Object.freeze(draft);
}

/** `[preflight.risk]` over the layered snapshot (packs, base, active profile). */
export function loadNimbusPreflightRiskFromConfigDir(configDir: string): NimbusPreflightRiskToml {
  const raw = layeredConfigText(configDir);
  if (raw === null) return DEFAULT_PREFLIGHT_RISK_CONFIG;
  return parseNimbusTomlPreflightRisk(raw, sectionFallbackSink(configDir, "preflight.risk"));
}
