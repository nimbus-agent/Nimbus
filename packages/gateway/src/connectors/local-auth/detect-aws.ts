import { cliEnvFor } from "./local-auth-env.ts";
import type { LocalAuthHostDeps } from "./local-auth-host.ts";
import type { AwsFinding } from "./local-auth-types.ts";

function lines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * ONE spawn however many profiles exist. Regions are NOT read here — only the profile the owner
 * picks needs one, so `awsRegionFor` runs once, at adoption. (Not an INI parser: re-implementing
 * AWS config semantics — sso-session sections, source_profile, env-overridden paths — would be a
 * second source of truth drifting from the CLI that actually authenticates.)
 */
export async function detectAws(
  deps: LocalAuthHostDeps,
  alreadyConfigured: boolean,
): Promise<AwsFinding> {
  const base = { source: "aws" as const, alreadyConfigured };
  if (!deps.which("aws")) {
    return {
      ...base,
      profiles: [],
      status: "cli_not_found",
      reason: "aws CLI is not installed (not found on PATH)",
    };
  }
  const r = await deps.run(["aws", "configure", "list-profiles"], cliEnvFor("aws", deps.env));
  const profiles = r.ok ? lines(r.stdout) : [];
  if (profiles.length === 0) {
    return {
      ...base,
      profiles: [],
      status: "not_logged_in",
      reason: "no AWS profiles are configured — run: aws configure (or aws configure sso)",
    };
  }
  return { ...base, profiles, status: "available" };
}

export async function awsRegionFor(
  deps: LocalAuthHostDeps,
  profile: string,
): Promise<string | null> {
  const r = await deps.run(
    ["aws", "configure", "get", "region", "--profile", profile],
    cliEnvFor("aws", deps.env),
  );
  const region = r.ok ? r.stdout.trim() : "";
  return region === "" ? null : region;
}
