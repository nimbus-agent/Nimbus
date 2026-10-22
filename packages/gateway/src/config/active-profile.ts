import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processEnvGet } from "../platform/env-access.ts";

export const PROFILE_NAME_RE = /^[a-z0-9_-]{1,32}$/i;

const PROFILE_MARKER = ".nimbus-profile";
const DEFAULT_PROFILE = "default";

export type ProfileSource = "argument" | "env" | "marker" | "default";

export type ResolvedProfile = { readonly name: string; readonly source: ProfileSource };

export class InvalidProfileNameError extends Error {
  readonly value: string;
  readonly source: ProfileSource;

  constructor(value: string, source: ProfileSource) {
    super(`Invalid profile name from ${source}: ${value}`);
    this.name = "InvalidProfileNameError";
    this.value = value;
    this.source = source;
  }
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT";
}

/**
 * The trimmed `.nimbus-profile` marker, or undefined when absent, empty or `default`.
 * A marker that exists but cannot be read (a directory, no permission) THROWS an error naming
 * the file: this is the boot read, and guessing "default" would run the wrong profile silently.
 */
export function readProfileMarker(configDir: string): string | undefined {
  const path = join(configDir, PROFILE_MARKER);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (err) {
    if (isEnoent(err)) return undefined;
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read the profile marker ${path}: ${message}`);
  }
  if (raw === "" || raw === DEFAULT_PROFILE) return undefined;
  return raw;
}

/** `readProfileMarker` for display sites (diag, explain, profile lists): unreadable is absent. */
export function tryReadProfileMarker(configDir: string): string | undefined {
  try {
    return readProfileMarker(configDir);
  } catch {
    return undefined;
  }
}

/** Path of a profile's overlay file; null for the default profile (no overlay). */
export function profileFilePath(configDir: string, name: string): string | null {
  if (name === DEFAULT_PROFILE) return null;
  return join(configDir, `nimbus.${name}.toml`);
}

function validated(value: string, source: ProfileSource): ResolvedProfile {
  if (!PROFILE_NAME_RE.test(value)) throw new InvalidProfileNameError(value, source);
  return { name: value, source };
}

/**
 * The one place that decides which profile is active:
 * explicit argument, then `NIMBUS_PROFILE`, then the `.nimbus-profile` marker, else default.
 * An env value of `default` (or empty) falls through to the marker.
 */
export function resolveActiveProfile(opts: {
  configDir: string;
  explicit?: string;
  env?: (k: string) => string | undefined;
}): ResolvedProfile {
  const { configDir, explicit } = opts;
  const env = opts.env ?? processEnvGet;
  if (explicit !== undefined && explicit !== "") return validated(explicit, "argument");
  const fromEnv = env("NIMBUS_PROFILE")?.trim();
  if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== DEFAULT_PROFILE) {
    return validated(fromEnv, "env");
  }
  const marker = readProfileMarker(configDir);
  if (marker !== undefined) return validated(marker, "marker");
  return { name: DEFAULT_PROFILE, source: "default" };
}
