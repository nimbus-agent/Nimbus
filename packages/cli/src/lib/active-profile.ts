import { existsSync, readFileSync } from "node:fs";
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

/** The profile marker's trimmed content, or undefined when absent, empty or "default". */
export function readProfileMarker(configDir: string): string | undefined {
  const p = join(configDir, PROFILE_MARKER);
  if (!existsSync(p)) {
    return undefined;
  }
  const raw = readFileSync(p, "utf8").trim();
  if (raw === "" || raw === "default") {
    return undefined;
  }
  return raw;
}

export function resolveCliActiveProfile(
  configDir: string,
  env: (k: string) => string | undefined = (k) => process.env[k],
): string {
  const fromEnv = env("NIMBUS_PROFILE")?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== "default") {
    return checked(fromEnv, "NIMBUS_PROFILE");
  }
  const marker = readProfileMarker(configDir);
  if (marker !== undefined) {
    return checked(marker, PROFILE_MARKER);
  }
  return "default";
}

/** Where `nimbus config set|edit` writes: the active profile's file (even if missing), else nimbus.toml. */
export function cliWriteTargetPath(
  configDir: string,
  env?: (k: string) => string | undefined,
): string {
  const name = resolveCliActiveProfile(configDir, env);
  return join(configDir, name === "default" ? "nimbus.toml" : `nimbus.${name}.toml`);
}
