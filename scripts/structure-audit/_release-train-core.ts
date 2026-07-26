/**
 * Primitives shared by every release-train edge kind. This module is a LEAF:
 * it imports nothing from its siblings, which is what lets both the Phase 1
 * channel readers and the Phase 2 dependency readers depend on it without
 * forming an import cycle.
 */

export function stripV(version: string): string {
  return version.replace(/^v/, "");
}

/**
 * Semver ordering that never throws. `Bun.semver.order` throws on an unparseable
 * version ("Invalid SemVer: ..."), and channel files are external — a format
 * quirk must degrade to "indeterminate", not crash the whole audit. Returns
 * -1 | 0 | 1, or null when either side is not valid semver.
 */
export function compareSemver(a: string, b: string): number | null {
  try {
    return Bun.semver.order(stripV(a), stripV(b));
  } catch {
    return null;
  }
}

/** ISO-8601 with an explicit UTC designator or numeric offset. */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Hours between an ISO-8601 (Z-suffixed) timestamp and now, UTC epoch-ms math.
 * An unparseable date yields `+Infinity` (fail-CLOSED): a NaN age would satisfy
 * `NaN > graceHours === false` and silently mask a phantom/stale state as "ok",
 * so an unreadable timestamp instead forces the aged-check to fire.
 */
export function ageHours(isoZ: string): number {
  // A timestamp without an explicit zone would be parsed as LOCAL time, making
  // the age differ between a laptop and a UTC runner. Treat it as unreadable
  // and fail CLOSED, exactly like an unparseable date.
  if (!HAS_TIMEZONE.test(isoZ.trim())) return Number.POSITIVE_INFINITY;
  const t = new Date(isoZ).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 3_600_000;
}

export interface ReleaseInfo {
  tag: string;
  prerelease: boolean;
  draft: boolean;
  assets: string[];
  publishedAt: string;
}
export interface PublishedRelease {
  version: string;
  publishedAt: string;
}

export type EdgeVerdict = "ok" | "stale" | "phantom" | "indeterminate";
export interface EdgeResult {
  edge: string;
  verdict: EdgeVerdict;
  detail: string;
}

/**
 * Exit decision. Any stale/phantom edge => red. Otherwise green with a warning
 * per indeterminate edge — EXCEPT a run where nothing was evaluable (no ok, only
 * indeterminate) under --strict is red: "indeterminate" must not read as "all
 * clear" in the scheduled sweep (the team-reachability rule).
 */
export function decideExit(
  results: EdgeResult[],
  strict: boolean,
): { code: 0 | 1; messages: string[] } {
  const messages: string[] = [];
  const hard = results.filter((r) => r.verdict === "phantom" || r.verdict === "stale");
  const indet = results.filter((r) => r.verdict === "indeterminate");
  const ok = results.filter((r) => r.verdict === "ok");
  for (const r of hard) messages.push(`::error::${r.edge}: ${r.detail}`);
  for (const r of indet) messages.push(`::warning::${r.edge}: ${r.detail} (indeterminate)`);
  if (hard.length > 0) return { code: 1, messages };
  if (ok.length === 0 && indet.length > 0 && strict) {
    messages.push(
      "::error::release-staleness: indeterminate — nothing could be evaluated (all reads failed transiently)",
    );
    return { code: 1, messages };
  }
  return { code: 0, messages };
}
