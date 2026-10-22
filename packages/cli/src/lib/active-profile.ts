import { readFileSync } from "node:fs";
import { join } from "node:path";

// The CLI cannot import the gateway, so this mirrors `packages/gateway/src/config/active-profile.ts`
// (order: env, then marker, then "default"). `profiles-cli-parity.test.ts` pins the slug rule.
export const PROFILE_NAME_RE = /^[a-z0-9_-]{1,32}$/i;

const PROFILE_MARKER = ".nimbus-profile";

function checked(name: string, origin: string): string {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}" (from ${origin}): use 1-32 letters, digits, "_" or "-".`,
    );
  }
  return name;
}

/**
 * The profile marker's trimmed content, or undefined when absent, empty or "default". A marker
 * that exists but cannot be read throws an error naming the file, as the gateway's boot read does.
 */
export function readProfileMarker(configDir: string): string | undefined {
  const p = join(configDir, PROFILE_MARKER);
  let raw: string;
  try {
    raw = readFileSync(p, "utf8").trim();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw new Error(
      `could not read the profile marker ${p}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (raw === "" || raw === "default") {
    return undefined;
  }
  return raw;
}

/** `readProfileMarker` for display (`nimbus profile list`): an unreadable marker reads as absent. */
export function tryReadProfileMarker(configDir: string): string | undefined {
  try {
    return readProfileMarker(configDir);
  } catch {
    return undefined;
  }
}

/** The active profile and where it came from (the gateway's `ProfileSource`, minus "argument"). */
export type CliResolvedProfile = {
  readonly name: string;
  readonly source: "env" | "marker" | "default";
};

export function resolveCliActiveProfileWithSource(
  configDir: string,
  env: (k: string) => string | undefined = (k) => process.env[k],
): CliResolvedProfile {
  const fromEnv = env("NIMBUS_PROFILE")?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== "default") {
    return { name: checked(fromEnv, "NIMBUS_PROFILE"), source: "env" };
  }
  const marker = readProfileMarker(configDir);
  if (marker !== undefined) {
    return { name: checked(marker, PROFILE_MARKER), source: "marker" };
  }
  return { name: "default", source: "default" };
}

export function resolveCliActiveProfile(
  configDir: string,
  env: (k: string) => string | undefined = (k) => process.env[k],
): string {
  return resolveCliActiveProfileWithSource(configDir, env).name;
}

/** Where `nimbus config set|edit` writes: the active profile's file (even if missing), else nimbus.toml. */
export function cliWriteTargetPath(
  configDir: string,
  env?: (k: string) => string | undefined,
): string {
  const name = resolveCliActiveProfile(configDir, env);
  return join(configDir, name === "default" ? "nimbus.toml" : `nimbus.${name}.toml`);
}
