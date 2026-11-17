import { stripControlChars } from "../lib/strip-control-chars.ts";

/**
 * `nimbus incident findings [--all] [--limit <n>] [--json]` (Phase 10 IC8): what the expectation radar and the
 * anomaly baseline noticed, from the gateway's `incident.findings`. A finding is a record, never an action. Keys
 * and service names come from the owner's config and connector ids; they are still stripped of control characters.
 */

export const FINDINGS_USAGE_LINE = "       nimbus incident findings [--all] [--limit <n>] [--json]";

export type FindingsArgs = {
  readonly verb: "findings";
  readonly json: boolean;
  readonly all: boolean;
  readonly limit?: number;
};

export function parseFindingsArgs(argv: readonly string[]): FindingsArgs | undefined {
  let json = false;
  let all = false;
  let limit: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (seen.has(a)) return undefined;
    seen.add(a);
    if (a === "--json") json = true;
    else if (a === "--all") all = true;
    else if (a === "--limit") {
      const v = argv[i + 1];
      if (v === undefined || !/^\d{1,3}$/.test(v)) return undefined;
      const n = Number(v);
      if (n < 1 || n > 500) return undefined;
      limit = n;
      i += 1;
    } else return undefined;
  }
  return { verb: "findings", json, all, ...(limit === undefined ? {} : { limit }) };
}

export interface FindingLike {
  readonly kind: string;
  readonly key: string;
  readonly service: string | null;
  readonly detail: unknown;
  readonly openedAtMs: number;
  readonly lastSeenAtMs: number;
  readonly clearedAtMs: number | null;
}

export interface FindingsReplyLike {
  readonly findings: readonly FindingLike[];
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function num(d: Record<string, unknown>, k: string): number | null {
  const v = d[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function gap(ms: number): string {
  if (ms % 86_400_000 === 0) return `${String(ms / 86_400_000)}d`;
  if (ms % 3_600_000 === 0) return `${String(ms / 3_600_000)}h`;
  return `${String(Math.round(ms / 60_000))}m`;
}

/** One line of what the finding says, from its numeric detail only. */
function summary(f: FindingLike): string {
  const d =
    typeof f.detail === "object" && f.detail !== null ? (f.detail as Record<string, unknown>) : {};
  if (f.kind === "radar") {
    const last = num(d, "lastAtMs");
    const max = num(d, "maxGapMs");
    return `no matching event ${last === null ? "ever seen" : `since ${iso(last)}`}${max === null ? "" : ` (expected within ${gap(max)})`}`;
  }
  const value = num(d, "value");
  const z = num(d, "z");
  const mean = num(d, "mean");
  const parts = [
    value === null ? null : `value ${String(value)}`,
    mean === null ? null : `usual ${String(mean)}`,
    z === null ? null : `z ${String(z)}`,
  ].filter((x): x is string => x !== null);
  return parts.join(", ");
}

export function formatFindings(r: FindingsReplyLike, all: boolean): string {
  if (r.findings.length === 0) {
    return all ? "No findings recorded." : "No open findings.";
  }
  const lines = [all ? "Findings (open first, then cleared):" : "Open findings:"];
  for (const f of r.findings) {
    const state =
      f.clearedAtMs === null ? `open since ${iso(f.openedAtMs)}` : `cleared ${iso(f.clearedAtMs)}`;
    lines.push(
      `  ${stripControlChars(f.kind).padEnd(8)} ${stripControlChars(f.key)}  ${state}; ${stripControlChars(summary(f))}`,
    );
  }
  lines.push("A finding is a record only: nothing was run.");
  return lines.join("\n");
}
