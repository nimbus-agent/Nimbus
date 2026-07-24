/**
 * Shared plumbing for the org-drift-sweep audit gates (ruleset-drift,
 * org-settings-drift, team-reachability). Each gate keeps its own diff logic;
 * this holds only what all three do identically: run `gh`, decide strict mode,
 * and render the "nothing could be read" outcome.
 */

export interface GhResult {
  ok: boolean;
  stdout: string;
}

/** Narrow an unknown to a plain object (not null, not an array) before indexing it. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Wraps `Bun.spawnSync` so a missing `gh` binary or non-zero exit both surface as `ok: false`. */
export function runGh(args: string[]): GhResult {
  try {
    const proc = Bun.spawnSync(args);
    if (!proc.success) return { ok: false, stdout: "" };
    return { ok: true, stdout: new TextDecoder().decode(proc.stdout) };
  } catch {
    return { ok: false, stdout: "" };
  }
}

/**
 * Strict mode makes a "nothing readable" outcome a hard failure instead of a
 * soft green skip. The scheduled sweep passes `--strict`; `GITHUB_ACTIONS` is a
 * safety net so a forgotten flag still hardens CI. Local/preflight runs (no
 * flag, no env) stay soft so an unauthenticated contributor is never blocked.
 */
export function isStrict(argv: string[], env: Record<string, string | undefined>): boolean {
  return argv.includes("--strict") || env["GITHUB_ACTIONS"] === "true";
}

export interface AuditOutcome {
  code: 0 | 1;
  message: string;
}

/**
 * The outcome when a gate could read *nothing* (no `gh`, no auth, or a broken
 * App permission). Soft skip locally; in the CI sweep (`strict`) the token must
 * work, so this is a loud red — a silent green here is the failure mode P6a's
 * review flagged. Both messages carry an Actions annotation prefix.
 *
 * An optional `reason` overrides the default "nothing was readable" framing
 * for a gate-specific outcome — e.g. reachability needs every team's repo
 * list, so a partial read (some calls succeeded, a later one failed) is
 * indeterminate rather than "nothing readable". Omitting `reason` keeps the
 * default message byte-identical to before.
 */
export function strictSkip(label: string, strict: boolean, reason?: string): AuditOutcome {
  // A gate-specific reason: something WAS read but the gate cannot complete
  // (e.g. reachability needs every team's repo list — a partial read is
  // indeterminate, not "nothing readable").
  if (reason !== undefined) {
    return strict
      ? { code: 1, message: `::error::${label}: ${reason}` }
      : { code: 0, message: `::warning::${label}: skipped — ${reason}` };
  }
  // Default: nothing was readable at all (no `gh`, no auth, or a broken token).
  if (strict) {
    return {
      code: 1,
      message: `::error::${label}: could not authenticate — the App token or a required permission is broken (nothing was readable)`,
    };
  }
  return {
    code: 0,
    message: `::warning::${label}: skipped — gh unavailable or unauthenticated`,
  };
}
