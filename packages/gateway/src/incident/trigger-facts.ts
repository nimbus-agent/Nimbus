import type { TriggerService } from "./trigger-sources.ts";

/**
 * What the incident engine reads from a trigger item's metadata (Phase 10 IC3, design B). THE ONLY FILE that
 * reads a source's metadata keys, so the lane-census annotations live in one place and a writer that renames a
 * key fails one pin test (`trigger-facts.test.ts`, driven by the real mappers).
 *
 * `qualifies` (in code) and `qualifiesSql` (a `json_extract` fragment) are built from the SAME per-source label
 * tables and the SAME ASCII-only normalisation (`lower` and `trim` in SQLite are ASCII-only, so the code is too),
 * so the SQL pre-filter that runs before the engine's cap and the in-code check cannot disagree.
 *
 * Vocabulary note: Monte Carlo's and Bigeye's `severity` and `status` strings are UNVERIFIED against a live
 * account, so a status counts as closed only for the words listed, and anything else reads open.
 */

export type TriggerStatus = "open" | "closed" | "unknown";
/** `provider`: the vendor's own time. `observed`: the sync's observation (item_history). `none`: no time. */
export type TimeBasis = "provider" | "observed" | "none";

export type TriggerFacts = {
  readonly status: TriggerStatus;
  readonly statusRaw: string | null;
  /** The NORMALISED severity label (Bigeye: null), the value `[incident] severities` is compared with. */
  readonly severity: string | null;
  readonly severityRaw: string | null;
  readonly openedAtMs: number | null;
  readonly openedAtBasis: TimeBasis;
  readonly closedAtMs: number | null;
  readonly closedAtBasis: TimeBasis;
  /** Bigeye only: the lower-cased `slaStatus` (null for every other source). */
  readonly slaStatus: string | null;
  /** False when the metadata column did not parse as a JSON object; every other field is then empty. */
  readonly metadataValid: boolean;
};

export type TriggerConfig = {
  /** `[incident] severities`: non-empty REPLACES the per-source defaults for every source with a severity. */
  readonly severities: readonly string[];
  /** `[incident] bigeye_sla_statuses`. */
  readonly bigeyeSlaStatuses: readonly string[];
  /** `[pagerduty] severity_p1_aliases`. */
  readonly pagerdutyP1Aliases: readonly string[];
};

const EMPTY_FACTS: TriggerFacts = Object.freeze({
  status: "unknown",
  statusRaw: null,
  severity: null,
  severityRaw: null,
  openedAtMs: null,
  openedAtBasis: "none",
  closedAtMs: null,
  closedAtBasis: "none",
  slaStatus: null,
  metadataValid: false,
});

/** ASCII-only lower-casing, to match SQLite's `lower()` exactly. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Trim ASCII spaces only, to match SQLite's one-argument `trim()` exactly. */
function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charCodeAt(a) === 32) a += 1;
  while (b > a && s.charCodeAt(b - 1) === 32) b -= 1;
  return s.slice(a, b);
}

/** The label stripping Monte Carlo needs (`SEV-1`, `sev_1`, `Sev 1`): space, tab, LF, CR, `_` and `-`. */
function stripSeparators(s: string): string {
  return s.replace(/[ \t\n\r_-]/g, "");
}

function plainLabel(raw: string): string {
  return asciiLower(trimSpaces(raw));
}

function monteCarloLabel(raw: string): string {
  return stripSeparators(plainLabel(raw));
}

type Meta = Record<string, unknown>;

function parseMeta(raw: string | null): Meta | null {
  if (raw === null || raw === "") return null;
  try {
    const v: unknown = JSON.parse(raw);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Meta) : null;
  } catch {
    return null;
  }
}

function str(meta: Meta, key: string): string | null {
  const v = meta[key];
  return typeof v === "string" ? v : null;
}

function finiteMs(meta: Meta, key: string): number | null {
  const v = meta[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function isoMs(meta: Meta, key: string): number | null {
  const v = str(meta, key);
  if (v === null) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The status words that read closed, per source (anything else, present, reads open). */
const CLOSED_WORDS: Readonly<Record<TriggerService, readonly string[]>> = {
  pagerduty: ["resolved"],
  jira: ["closed"],
  sentry: ["resolved", "ignored"],
  montecarlo: ["resolved", "closed"],
  bigeye: [],
};

/** Whether a status VALUE (e.g. an `item_history` new value) reads closed for `service`. */
export function isClosedStatusWord(service: TriggerService, raw: string | null): boolean {
  return raw !== null && CLOSED_WORDS[service].includes(asciiLower(trimSpaces(raw)));
}

function statusOf(
  raw: string | null,
  closed: readonly string[],
  missing: TriggerStatus,
): TriggerStatus {
  if (raw === null) return missing;
  return closed.includes(asciiLower(trimSpaces(raw))) ? "closed" : "open";
}

function timePair(
  ms: number | null,
  basisWhenPresent: TimeBasis,
): { ms: number | null; basis: TimeBasis } {
  return ms === null ? { ms: null, basis: "none" } : { ms, basis: basisWhenPresent };
}

function pagerdutyFacts(meta: Meta): TriggerFacts {
  const statusRaw = str(meta, "status");
  const status = statusOf(statusRaw, CLOSED_WORDS.pagerduty, "open");
  const severityRaw = str(meta, "severity");
  const opened = timePair(finiteMs(meta, "opened_at_ms"), "provider");
  const closed =
    status === "closed"
      ? timePair(finiteMs(meta, "resolved_at_ms"), "provider")
      : timePair(null, "none");
  return {
    ...EMPTY_FACTS,
    metadataValid: true,
    status,
    statusRaw,
    severityRaw,
    severity: severityRaw === null ? null : plainLabel(severityRaw),
    openedAtMs: opened.ms,
    openedAtBasis: opened.basis,
    closedAtMs: closed.ms,
    closedAtBasis: closed.basis,
  };
}

function jsmFacts(meta: Meta): TriggerFacts {
  const statusRaw = str(meta, "status");
  const status = statusOf(statusRaw, CLOSED_WORDS.jira, "unknown");
  const severityRaw = str(meta, "priority");
  const opened = timePair(finiteMs(meta, "opened_at_ms"), "provider");
  const closed =
    status === "closed"
      ? timePair(finiteMs(meta, "closed_at_ms"), "provider")
      : timePair(null, "none");
  return {
    ...EMPTY_FACTS,
    metadataValid: true,
    status,
    statusRaw,
    severityRaw,
    severity: severityRaw === null ? null : plainLabel(severityRaw),
    openedAtMs: opened.ms,
    openedAtBasis: opened.basis,
    closedAtMs: closed.ms,
    closedAtBasis: closed.basis,
  };
}

function sentryFacts(meta: Meta): TriggerFacts {
  const statusRaw = str(meta, "status");
  const status = statusOf(statusRaw, CLOSED_WORDS.sentry, "unknown");
  const severityRaw = str(meta, "level");
  const opened = timePair(finiteMs(meta, "firstSeen"), "provider");
  return {
    ...EMPTY_FACTS,
    metadataValid: true,
    status,
    statusRaw,
    severityRaw,
    severity: severityRaw === null ? null : plainLabel(severityRaw),
    openedAtMs: opened.ms,
    openedAtBasis: opened.basis,
    // Sentry gives no resolve time: the assembler fills it from item_history (basis observed).
    closedAtMs: null,
    closedAtBasis: status === "closed" ? "observed" : "none",
  };
}

function monteCarloFacts(meta: Meta): TriggerFacts {
  const statusRaw = str(meta, "status");
  const status = statusOf(statusRaw, CLOSED_WORDS.montecarlo, "unknown");
  const severityRaw = str(meta, "severity");
  const opened = timePair(isoMs(meta, "firstSeenAt"), "provider");
  return {
    ...EMPTY_FACTS,
    metadataValid: true,
    status,
    statusRaw,
    severityRaw,
    severity: severityRaw === null ? null : monteCarloLabel(severityRaw),
    openedAtMs: opened.ms,
    openedAtBasis: opened.basis,
    closedAtMs: null,
    closedAtBasis: status === "closed" ? "observed" : "none",
  };
}

function bigeyeFacts(meta: Meta): TriggerFacts {
  const sla = str(meta, "slaStatus");
  // No status key, no severity, and no open time: `modified_at` is the sync time, never an open time.
  return {
    ...EMPTY_FACTS,
    metadataValid: true,
    slaStatus: sla === null ? null : plainLabel(sla),
  };
}

const FACTS_BY_SERVICE: Readonly<Record<TriggerService, (meta: Meta) => TriggerFacts>> = {
  pagerduty: pagerdutyFacts,
  jira: jsmFacts,
  sentry: sentryFacts,
  montecarlo: monteCarloFacts,
  bigeye: bigeyeFacts,
};

/** The facts of one trigger item row. Never throws: malformed metadata gives `metadataValid: false`. */
export function triggerFacts(row: {
  readonly service: TriggerService;
  readonly metadata: string | null;
}): TriggerFacts {
  const meta = parseMeta(row.metadata);
  if (meta === null) return EMPTY_FACTS;
  return FACTS_BY_SERVICE[row.service](meta);
}

const DEFAULT_LABELS: Readonly<Record<TriggerService, readonly string[]>> = {
  pagerduty: ["p1"],
  jira: ["p1"],
  sentry: ["fatal"],
  montecarlo: ["sev1", "high"],
  bigeye: [],
};

/**
 * The normalised severity label of a raw value, the way `triggerFacts` normalises each source's own (Monte Carlo
 * also drops separators). The on-call push compares its configured severities with a record's stored label
 * through this, so `SEV-1` in `[oncall.push] severities` matches a Monte Carlo record stored as `sev1`.
 */
export function normaliseSeverityLabel(service: TriggerService, raw: string): string {
  return service === "montecarlo" ? monteCarloLabel(raw) : plainLabel(raw);
}

/**
 * The labels that qualify an item of `service` for assembly: the per-source defaults (PagerDuty adds the
 * `[pagerduty]` P1 aliases), REPLACED by a non-empty `[incident] severities`. Bigeye has no severity, so only
 * `bigeye_sla_statuses` qualifies it. One function feeds both `qualifies` and `qualifiesSql`.
 */
export function qualifyingLabels(
  service: TriggerService,
  config: TriggerConfig,
): readonly string[] {
  if (service === "bigeye") return config.bigeyeSlaStatuses.map(plainLabel);
  const base =
    config.severities.length > 0
      ? config.severities
      : service === "pagerduty"
        ? [...DEFAULT_LABELS.pagerduty, ...config.pagerdutyP1Aliases]
        : DEFAULT_LABELS[service];
  const normalise = service === "montecarlo" ? monteCarloLabel : plainLabel;
  return [...new Set(base.map(normalise))];
}

/** Whether `facts` qualifies a trigger of `service` for assembly. Status-blind by design (design B). */
export function qualifies(
  service: TriggerService,
  facts: TriggerFacts,
  config: TriggerConfig,
): boolean {
  const labels = qualifyingLabels(service, config);
  const label = service === "bigeye" ? facts.slaStatus : facts.severity;
  return label !== null && labels.includes(label);
}

/** The metadata key each source's qualifying label is read from. */
const LABEL_KEY: Readonly<Record<TriggerService, string>> = {
  pagerduty: "severity",
  jira: "priority",
  sentry: "level",
  montecarlo: "severity",
  bigeye: "slaStatus",
};

export type QualifiesSql = {
  /** A boolean SQL expression over the `item` alias given to `qualifiesSql`. */
  readonly clause: string;
  /** Bound parameters, in order: ONE JSON array of the qualifying labels. */
  readonly params: readonly string[];
};

/**
 * `qualifies` as SQL over `<alias>.metadata`, so the engine's selection filters by severity BEFORE its row cap
 * (a cap that ran first would let non-qualifying items hide qualifying ones for ever). Values are bound; the key
 * and alias are code constants. A non-text or malformed value never qualifies.
 */
export function qualifiesSql(
  service: TriggerService,
  config: TriggerConfig,
  alias = "i",
): QualifiesSql {
  const labels = qualifyingLabels(service, config);
  if (labels.length === 0) return { clause: "0", params: [] };
  const path = `'$.${LABEL_KEY[service]}'`;
  const col = `${alias}.metadata`;
  const text = `CASE WHEN json_valid(${col}) AND json_type(${col}, ${path}) = 'text' THEN lower(trim(json_extract(${col}, ${path}))) END`;
  const expr =
    service === "montecarlo"
      ? `replace(replace(replace(replace(replace(replace(${text}, ' ', ''), char(9), ''), char(10), ''), char(13), ''), '_', ''), '-', '')`
      : text;
  return {
    clause: `${expr} IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify(labels)],
  };
}
