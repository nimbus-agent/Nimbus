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
 */
export function strictSkip(label: string, strict: boolean): AuditOutcome {
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
