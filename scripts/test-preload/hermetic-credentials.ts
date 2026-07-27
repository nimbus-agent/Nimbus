/**
 * Test preload — blank the developer's real credentials before any test module loads.
 *
 * Registered as `[test] preload` in bunfig.toml, so it runs before EVERY test file and,
 * critically, before anything can import `packages/gateway/src/config.ts` — whose `Config`
 * is a module-level literal that snapshots `process.env` exactly once, at first import.
 *
 * Why this exists. Issue #812: the connector-auth suite blanked `NIMBUS_OAUTH_*` at its own
 * top level and imported lazily, which only worked while it happened to be the FIRST file in
 * the process to load `config.ts`. In a combined run a sibling got there first, the blanking
 * became a silent no-op, and on a machine with Google OAuth configured the suite walked past
 * its fail-closed guard into a real PKCE round-trip — a live local redirect listener and a
 * real request to Google carrying the developer's own client id and secret. It passed alone,
 * hung in the combined run, and was invisible in CI, which has no credentials to leak.
 *
 * Per-file blanking cannot fix that class, because "am I first?" is not something a test file
 * can know. A preload can: it is ordered before all of them by construction.
 *
 * Blanked, not deleted. `Config` reads `processEnvGet(x) ?? ""`, so an empty string and an
 * absent var are equivalent to it, and an empty string additionally survives code that only
 * checks `in process.env`.
 *
 * This does NOT stop a test from setting a credential itself — several legitimately do
 * (`mendeley-access-token.test.ts`, `notion-access-token.test.ts`). Those assignments happen
 * after preload and are untouched. The only thing removed is INHERITANCE from the developer's
 * shell, which no test may depend on: CI has none of these set, so any test that needed one
 * would already be failing there.
 */

/** Prefixes we own, or that name a paid API a test must never reach for real. */
const CREDENTIAL_PREFIXES = ["NIMBUS_", "OPENAI_", "ANTHROPIC_"] as const;

/** Name shapes that denote a secret rather than a setting (a model name or a host is fine). */
const CREDENTIAL_SUFFIXES = [
  "_CLIENT_ID",
  "_CLIENT_SECRET",
  "_SECRET",
  "_TOKEN",
  "_PAT",
  "_API_KEY",
  "_KEY",
  "_ACCESS_KEY_ID",
  "_SECRET_ACCESS_KEY",
  "_PASSWORD",
] as const;

/**
 * Pattern-matched rather than enumerated: the credential surface is ~80 connectors wide and a
 * hand-maintained list would drift out of date exactly when a new connector is added — which
 * is the moment it would matter.
 */
export function isCredentialEnvName(name: string): boolean {
  if (!CREDENTIAL_PREFIXES.some((p) => name.startsWith(p))) return false;
  return CREDENTIAL_SUFFIXES.some((s) => name.endsWith(s));
}

/** Blanks matching keys in `env`; returns the NAMES blanked (never the values). */
export function blankCredentialEnv(env: Record<string, string | undefined>): string[] {
  const blanked: string[] = [];
  for (const name of Object.keys(env)) {
    if (env[name] !== undefined && env[name] !== "" && isCredentialEnvName(name)) {
      env[name] = "";
      blanked.push(name);
    }
  }
  return blanked.sort();
}

const blanked = blankCredentialEnv(process.env);
if (blanked.length > 0 && process.env["NIMBUS_TEST_PRELOAD_QUIET"] !== "1") {
  // Names only — printing a value here would put the very secret this guard exists to contain
  // into CI logs and terminal scrollback. Announced rather than silent so the behaviour is
  // discoverable: #812 was hard to read precisely because the leak was invisible.
  console.error(
    `[test-preload] blanked ${blanked.length} credential env var(s) for hermetic tests: ${blanked.join(", ")}`,
  );
}
