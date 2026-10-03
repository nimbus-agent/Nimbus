#!/usr/bin/env bun

/**
 * The blocking `bun audit --audit-level high` step's view of the accepted-advisory registry.
 *
 * `security.yml`'s required `Dependency audit` job runs two advisory steps, in order:
 *
 *   1. `bun audit --audit-level high` blocks on any HIGH/CRITICAL advisory;
 *   2. `bun run audit:advisories` holds EVERY live advisory, of any severity, to a row in
 *      `accepted-advisories.ts`, package-scoped and severity-aware.
 *
 * Step 1 used to ignore the registry. A HIGH advisory with no fix anywhere in the version graph,
 * which is the case the registry's step 3 ("accept, with a named unblocking condition") exists for,
 * could therefore only be handled by leaving the required check red for every PR. This module is
 * how step 1 reads the registry instead of keeping a second hand-kept list: each OPEN row becomes
 * one `--ignore=<GHSA>` argument, and every other row becomes nothing.
 *
 * A row is passed to step 1 only when all of the following hold. A failure on any of them
 * WITHHOLDS the row, so the blocking step fails on the real advisory, with bun's own output:
 *
 *   - its shape passes `checkRowShape`, the rule `audit:advisories` applies (every justification
 *     present, ISO dates, a window of 1..MAX_ACCEPTANCE_DAYS days);
 *   - it is not past its `recheckBy` (`isExpired`, the same inclusive rule `audit:advisories`
 *     applies): the acceptance stops on the day after `recheckBy`, with no grace period;
 *   - it is the only row for its package+advisory (a duplicate means the registry is malformed);
 *   - its `ghsa` is an EXACT GHSA id (see below);
 *   - no OTHER row naming the same GHSA is withheld (see below).
 *
 * Why the id must be exact. bun 1.3.14 drops an advisory when an `--ignore` value EQUALS its numeric
 * id or is a SUBSTRING of its advisory URL (`src/cli/audit_command.zig`:
 * `strings.eql(vulnerability.id, v) or strings.indexOf(vulnerability.url, v) != null`). Measured
 * against this lockfile, `--ignore=GHSA` on its own, or the bare `https://github.com/advisories/`
 * prefix, silences every advisory that exists. Only an anchored, full `GHSA-xxxx-xxxx-xxxx` matches
 * no URL but its own, so nothing else is ever emitted. A URL-form row (the registry's fallback for
 * a non-GHSA advisory), a partial id or a wrong-case id stays blocking. bun honours neither a CVE
 * id nor a comma-joined list either, so the output is one `--ignore=<GHSA>` argument per advisory.
 *
 * Why a GHSA is all-or-nothing across rows. The registry is package-scoped, but bun's `--ignore` is
 * not: it cannot say "this advisory, but only for package X". So when two rows name one GHSA and
 * either is withheld, both are.
 *
 * What step 1 cannot see, and step 2 catches: an advisory re-scored above its accepted severity,
 * and an accepted GHSA reported against a package that has no row. Step 1 passes over both, and
 * both fail `audit:advisories`, which runs next in the same required job and never passes
 * `--ignore`. That ordering is load-bearing: step 2 only gets to run because step 1 passed.
 *
 * CLI (what `security.yml` runs): prints the arguments on stdout, one per line and nothing else, and
 * explains every honoured and withheld row on stderr. It exits 0 even when it withholds rows, since
 * a withheld row is the expected way for an acceptance to lapse and the blocking step reports the
 * advisory itself. A non-zero exit means the registry could not be read; the workflow fails closed
 * on that.
 */

import { ACCEPTED_ADVISORIES, type AcceptedAdvisory } from "./accepted-advisories.ts";
import {
  checkRowShape,
  isExpired,
  isIsoDate,
  keyOf,
  utcToday,
} from "./check-accepted-advisories.ts";

/**
 * A full GHSA id exactly as bun's advisory URLs spell it: upper-case prefix, three lower-case
 * four-character groups. Anchored at both ends because bun's match is a substring match (see the
 * header). Anything this rejects is withheld, never repaired.
 */
const EXACT_GHSA_ID_RE = /^GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}$/;

/** A registry row the blocking step does NOT pass over, and why. */
export interface WithheldAcceptance {
  readonly ghsa: string;
  readonly package: string;
  readonly reason: string;
}

export interface BlockingAuditIgnores {
  /**
   * One `--ignore=<GHSA>` per honoured advisory, in registry order. Each one is its own argv entry,
   * because bun does not split a comma-joined value.
   */
  readonly args: readonly string[];
  /** The rows passed over, in registry order. */
  readonly honoured: readonly AcceptedAdvisory[];
  /** Every row that was NOT passed over, with the reason. */
  readonly withheld: readonly WithheldAcceptance[];
}

/** Why this row cannot be honoured on its own merits, or `null` if it can. */
function rowProblem(
  row: AcceptedAdvisory,
  today: string,
  rowsPerKey: ReadonlyMap<string, number>,
): string | null {
  if ((rowsPerKey.get(keyOf(row.package, row.ghsa)) ?? 0) > 1) {
    return "two or more rows for the same package+advisory, so the registry is malformed";
  }
  const shape = checkRowShape(row);
  if (shape.length > 0) {
    return `malformed: ${shape.map((f) => f.detail).join("; ")}`;
  }
  if (!EXACT_GHSA_ID_RE.test(row.ghsa)) {
    return `\`ghsa\` ${JSON.stringify(row.ghsa)} is not an exact GHSA id, and bun matches --ignore by substring`;
  }
  if (isExpired(row, today)) {
    return `recheckBy ${row.recheckBy} has passed, so re-judge it (unblocked by: ${row.unblockedBy})`;
  }
  return null;
}

/**
 * The `--ignore` arguments the blocking `bun audit --audit-level high` step may pass, given the
 * registry and today's UTC date (injected, as in `evaluateAdvisories`, so the boundary is testable).
 *
 * Throws on a `today` that is not a YYYY-MM-DD date. Comparing against `NaN` would make
 * `isExpired` false for every row, which would quietly keep every acceptance open.
 */
export function blockingAuditIgnores(
  accepted: readonly AcceptedAdvisory[],
  today: string,
): BlockingAuditIgnores {
  if (!isIsoDate(today)) {
    throw new Error(
      `blockingAuditIgnores: today must be YYYY-MM-DD (got ${JSON.stringify(today)})`,
    );
  }

  const rowsPerKey = new Map<string, number>();
  for (const row of accepted) {
    const key = keyOf(row.package, row.ghsa);
    rowsPerKey.set(key, (rowsPerKey.get(key) ?? 0) + 1);
  }

  const problems = accepted.map((row) => rowProblem(row, today, rowsPerKey));
  const withheldGhsas = new Set<string>();
  for (const [i, row] of accepted.entries()) {
    if (problems[i] !== null) withheldGhsas.add(row.ghsa);
  }

  const args: string[] = [];
  const honoured: AcceptedAdvisory[] = [];
  const withheld: WithheldAcceptance[] = [];
  for (const [i, row] of accepted.entries()) {
    const reason =
      problems[i] ??
      (withheldGhsas.has(row.ghsa)
        ? `another row for ${row.ghsa} is withheld, and bun cannot limit --ignore to one package`
        : null);
    if (reason !== null) {
      withheld.push({ ghsa: row.ghsa, package: row.package, reason });
      continue;
    }
    honoured.push(row);
    const arg = `--ignore=${row.ghsa}`;
    if (!args.includes(arg)) args.push(arg);
  }
  return { args, honoured, withheld };
}

if (import.meta.main) {
  const label = "advisory-ignore-args";
  const today = utcToday();
  const { args, honoured, withheld } = blockingAuditIgnores(ACCEPTED_ADVISORIES, today);

  // stderr only: stdout is the argument list the workflow reads, and must carry nothing else.
  console.error(
    `${label}: ${String(honoured.length)} open acceptance(s) in scripts/structure-audit/accepted-advisories.ts on ${today} (UTC)`,
  );
  for (const row of honoured) {
    console.error(
      `  passing over ${row.ghsa} (${row.package}, ${row.severity}); recheck by ${row.recheckBy}, owner ${row.owner}`,
    );
  }
  for (const w of withheld) {
    console.error(`::warning::${label}: NOT passing over ${w.ghsa} (${w.package}): ${w.reason}`);
  }
  process.stdout.write(args.map((a) => `${a}\n`).join(""));
}
