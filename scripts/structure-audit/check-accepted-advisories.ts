#!/usr/bin/env bun

/**
 * audit:advisories — hold every live npm advisory to a written decision.
 *
 * `bun audit --audit-level high` (security.yml) blocks merges on HIGH/CRITICAL.
 * Everything below that threshold used to just sit there: two advisories lived
 * in `bun audit` output for weeks because nothing failed and nothing recorded
 * that anyone had looked. This gate closes that gap. It runs `bun audit --json`
 * and fails when:
 *
 *   unaccepted         a live advisory nobody has judged (fix it, or add a row)
 *   expired            an accepted row past its `recheckBy` date
 *   stale              a row whose advisory has cleared (delete the row)
 *   severity-escalated the advisory was re-scored above the accepted level
 *   malformed          a row missing a justification, or dated implausibly
 *   duplicate          two rows for the same package+advisory
 *
 * The registry is `accepted-advisories.ts`. Needs network (the npm registry), so
 * it is a CI gate, not a local FAST-tier gate — see CI_ONLY_GATES in
 * scripts/lib/preflight-gates.ts.
 */

import {
  ACCEPTED_ADVISORIES,
  type AcceptedAdvisory,
  type AdvisorySeverity,
  MAX_ACCEPTANCE_DAYS,
} from "./accepted-advisories.ts";

export interface LiveAdvisory {
  readonly package: string;
  /** GHSA id parsed out of the advisory URL, or the raw URL when there is none. */
  readonly ghsa: string;
  readonly severity: AdvisorySeverity;
  readonly title: string;
  readonly vulnerableVersions: string;
}

export type FindingKind =
  | "unaccepted"
  | "expired"
  | "stale"
  | "severity-escalated"
  | "malformed"
  | "duplicate";

export interface Finding {
  readonly kind: FindingKind;
  readonly key: string;
  readonly detail: string;
}

const SEVERITY_ORDER: readonly AdvisorySeverity[] = ["info", "low", "moderate", "high", "critical"];

/**
 * Rank for the escalation check. An unrecognised severity ranks as `critical`
 * rather than 0, so a new severity label upstream can never quietly downgrade
 * an advisory past this gate.
 */
export function severityRank(severity: string): number {
  const i = SEVERITY_ORDER.indexOf(severity as AdvisorySeverity);
  return i === -1 ? SEVERITY_ORDER.length - 1 : i;
}

function normalizeSeverity(raw: unknown): AdvisorySeverity {
  return typeof raw === "string" && SEVERITY_ORDER.includes(raw as AdvisorySeverity)
    ? (raw as AdvisorySeverity)
    : "critical";
}

const GHSA_RE = /GHSA-[0-9a-z]+-[0-9a-z]+-[0-9a-z]+/i;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Parse `bun audit --json`. The body is an object keyed by package name whose
 * values are advisory arrays. Bun prints a version banner to stderr, but the
 * leading-`{` scan below also survives it arriving on stdout.
 *
 * Throws on a payload that is not JSON at all — a swallowed parse error would
 * report "no advisories", which is the exact failure mode this gate exists to
 * prevent.
 */
export function parseBunAudit(stdout: string): LiveAdvisory[] {
  const start = stdout.indexOf("{");
  if (start === -1)
    throw new Error(`bun audit --json produced no JSON body: ${stdout.slice(0, 200)}`);
  const parsed: unknown = JSON.parse(stdout.slice(start));
  if (!isRecord(parsed)) throw new Error("bun audit --json: expected an object keyed by package");

  const out: LiveAdvisory[] = [];
  for (const [pkg, advisories] of Object.entries(parsed)) {
    if (!Array.isArray(advisories)) continue;
    for (const a of advisories) {
      if (!isRecord(a)) continue;
      const url = str(a["url"]);
      out.push({
        package: pkg,
        ghsa: GHSA_RE.exec(url)?.[0] ?? url,
        severity: normalizeSeverity(a["severity"]),
        title: str(a["title"]),
        vulnerableVersions: str(a["vulnerable_versions"]),
      });
    }
  }
  return out;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(s: string): boolean {
  return ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

function daysBetween(fromIso: string, toIso: string): number {
  return (Date.parse(toIso) - Date.parse(fromIso)) / 86_400_000;
}

function keyOf(pkg: string, ghsa: string): string {
  return `${pkg}@${ghsa}`;
}

/** Every row must carry a real justification — a blank field is not a decision. */
const REQUIRED_PROSE: ReadonlyArray<keyof AcceptedAdvisory> = [
  "noFixReason",
  "reachability",
  "unblockedBy",
  "owner",
];

function checkRowShape(row: AcceptedAdvisory): Finding[] {
  const key = keyOf(row.package, row.ghsa);
  const findings: Finding[] = [];
  for (const field of REQUIRED_PROSE) {
    if (String(row[field]).trim().length === 0) {
      findings.push({ kind: "malformed", key, detail: `\`${field}\` is empty` });
    }
  }
  if (!isIsoDate(row.acceptedOn) || !isIsoDate(row.recheckBy)) {
    findings.push({
      kind: "malformed",
      key,
      detail: `acceptedOn/recheckBy must be YYYY-MM-DD (got ${row.acceptedOn} / ${row.recheckBy})`,
    });
    return findings;
  }
  const window = daysBetween(row.acceptedOn, row.recheckBy);
  if (window <= 0) {
    findings.push({ kind: "malformed", key, detail: "recheckBy must be after acceptedOn" });
  } else if (window > MAX_ACCEPTANCE_DAYS) {
    findings.push({
      kind: "malformed",
      key,
      detail: `acceptance window is ${window} days (max ${MAX_ACCEPTANCE_DAYS})`,
    });
  }
  return findings;
}

/**
 * Compare live advisories against the committed registry.
 *
 * `today` is injected rather than read from the clock so the expiry rule can be
 * tested at fixed dates. A test that asserted against `new Date()` would either
 * rot or silently stop exercising the boundary it was written for.
 */
export function evaluateAdvisories(
  live: readonly LiveAdvisory[],
  accepted: readonly AcceptedAdvisory[],
  today: string,
): Finding[] {
  const findings: Finding[] = [];

  const byKey = new Map<string, AcceptedAdvisory>();
  for (const row of accepted) {
    const key = keyOf(row.package, row.ghsa);
    if (byKey.has(key)) {
      findings.push({ kind: "duplicate", key, detail: "two accepted rows for the same advisory" });
      continue;
    }
    byKey.set(key, row);
    findings.push(...checkRowShape(row));
  }

  const liveKeys = new Set<string>();
  for (const adv of live) {
    const key = keyOf(adv.package, adv.ghsa);
    liveKeys.add(key);
    const row = byKey.get(key);
    if (!row) {
      findings.push({
        kind: "unaccepted",
        key,
        detail: `${adv.severity}: ${adv.title || adv.ghsa} (${adv.vulnerableVersions}) — fix it, or add a dated row to accepted-advisories.ts`,
      });
      continue;
    }
    if (severityRank(adv.severity) > severityRank(row.severity)) {
      findings.push({
        kind: "severity-escalated",
        key,
        detail: `re-scored ${row.severity} -> ${adv.severity}; the acceptance was made against the old score`,
      });
    }
    if (isIsoDate(row.recheckBy) && daysBetween(today, row.recheckBy) < 0) {
      findings.push({
        kind: "expired",
        key,
        detail: `recheckBy ${row.recheckBy} has passed — re-judge it (unblocked by: ${row.unblockedBy})`,
      });
    }
  }

  for (const key of byKey.keys()) {
    if (!liveKeys.has(key)) {
      findings.push({
        kind: "stale",
        key,
        detail: "no longer reported by bun audit — delete the row rather than leave drift",
      });
    }
  }

  return findings;
}

export function decideExit(findings: readonly Finding[]): { code: number; messages: string[] } {
  if (findings.length === 0) return { code: 0, messages: [] };
  return {
    code: 1,
    messages: findings.map((f) => `::error::audit:advisories ${f.kind} ${f.key}: ${f.detail}`),
  };
}

if (import.meta.main) {
  const label = "audit:advisories";
  const proc = Bun.spawnSync(["bun", "audit", "--json"], { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString();

  // `bun audit` exits non-zero when it finds anything, which is not an error
  // here — but an empty body with a non-zero exit means the command itself
  // failed (offline, registry down). Fail loudly; a silent "clean" is the one
  // outcome this gate must never produce.
  if (stdout.trim().length === 0) {
    console.error(
      `::error::${label}: \`bun audit --json\` produced no output (exit ${proc.exitCode}): ${proc.stderr.toString().slice(0, 400)}`,
    );
    process.exit(1);
  }

  const live = parseBunAudit(stdout);
  const today = new Date().toISOString().slice(0, 10);
  const out = decideExit(evaluateAdvisories(live, ACCEPTED_ADVISORIES, today));
  for (const m of out.messages) console.error(m);
  if (out.code === 0) {
    console.log(
      `${label}: OK (${live.length} live advisor${live.length === 1 ? "y" : "ies"}, all accounted for by ${ACCEPTED_ADVISORIES.length} accepted row(s))`,
    );
  }
  process.exit(out.code);
}
