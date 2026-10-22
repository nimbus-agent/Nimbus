import {
  copyFileSync,
  existsSync,
  constants as fsConstants,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { PROFILE_NAME_RE, tryReadProfileMarker } from "../lib/active-profile.ts";
import { getCliPlatformPaths } from "../paths.ts";

const PROFILE_MARKER = ".nimbus-profile";
const PROFILE_PREFIX = "nimbus.";
const PROFILE_SUFFIX = ".toml";

const activeProfileName = tryReadProfileMarker;

function listProfileFiles(configDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(PROFILE_PREFIX) && n.endsWith(PROFILE_SUFFIX) && n !== "nimbus.toml") {
      out.push(n.slice(PROFILE_PREFIX.length, -PROFILE_SUFFIX.length));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function printProfileHelp(): void {
  console.log(`nimbus profile — named TOML profiles (uses NIMBUS_PROFILE + nimbus.<name>.toml)

Usage:
  nimbus profile create <name>   Copy nimbus.toml to nimbus.<name>.toml (or seed minimal file)
  nimbus profile list
  nimbus profile switch <name>   Write ${PROFILE_MARKER} (picked up on nimbus start)
  nimbus profile delete <name> --yes
`);
}

/** Refuses a name the gateway would refuse at boot (`PROFILE_NAME_RE`). */
function assertProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(`Invalid profile name "${name}": use 1-32 letters, digits, "_" or "-".`);
  }
}

function fsErrorCode(e: unknown): string | undefined {
  if (e !== null && typeof e === "object" && "code" in e) {
    const c = e.code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

export function runProfileCreate(configDir: string, baseToml: string, tail: string[]): void {
  const name = tail[0]?.trim() ?? "";
  if (name === "" || name === "default") {
    throw new Error("Usage: nimbus profile create <name>");
  }
  assertProfileName(name);
  const dest = join(configDir, `${PROFILE_PREFIX}${name}${PROFILE_SUFFIX}`);
  try {
    copyFileSync(baseToml, dest, fsConstants.COPYFILE_EXCL);
  } catch (e: unknown) {
    const code = fsErrorCode(e);
    if (code === "EEXIST") {
      throw new Error(`Profile file already exists: ${dest}`);
    }
    if (code !== "ENOENT") {
      throw e;
    }
    writeFileSync(dest, `schema_version = 1\nprofile_name = "${name}"\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  console.log(`Created ${dest}`);
}

export function runProfileList(configDir: string): void {
  const active = activeProfileName(configDir);
  const profiles = listProfileFiles(configDir);
  console.log(`active: ${active ?? "(default — nimbus.toml)"}`);
  for (const p of profiles) {
    const mark = p === active ? "*" : " ";
    console.log(`${mark} ${p}`);
  }
  if (profiles.length === 0) {
    console.log("(no nimbus.<name>.toml profiles yet)");
  }
}

export function runProfileSwitch(configDir: string, tail: string[]): void {
  const name = tail[0]?.trim() ?? "";
  if (name === "") {
    throw new Error("Usage: nimbus profile switch <name>");
  }
  if (name === "default") {
    rmSync(join(configDir, PROFILE_MARKER), { force: true });
    console.log("Switched to default profile (nimbus.toml). Restart the Gateway.");
    return;
  }
  assertProfileName(name);
  const dest = join(configDir, `${PROFILE_PREFIX}${name}${PROFILE_SUFFIX}`);
  if (!existsSync(dest)) {
    throw new Error(`Unknown profile file: ${dest}`);
  }
  writeFileSync(join(configDir, PROFILE_MARKER), `${name}\n`, "utf8");
  console.log(
    `Active profile set to "${name}". Restart the Gateway (nimbus stop && nimbus start).`,
  );
}

export function runProfileDelete(configDir: string, tail: string[]): void {
  const name = tail[0]?.trim() ?? "";
  const yes = tail.includes("--yes");
  if (name === "" || !yes) {
    throw new Error("Usage: nimbus profile delete <name> --yes");
  }
  const dest = join(configDir, `${PROFILE_PREFIX}${name}${PROFILE_SUFFIX}`);
  if (!existsSync(dest)) {
    throw new Error(`Unknown profile file: ${dest}`);
  }
  rmSync(dest, { force: true });
  if (activeProfileName(configDir) === name) {
    rmSync(join(configDir, PROFILE_MARKER), { force: true });
  }
  console.log(`Deleted profile ${name}`);
}

export function runProfile(args: string[]): void {
  const sub = args[0];
  const tail = args.slice(1);
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printProfileHelp();
    return;
  }

  const paths = getCliPlatformPaths();
  const baseToml = join(paths.configDir, "nimbus.toml");

  if (sub === "create") {
    runProfileCreate(paths.configDir, baseToml, tail);
    return;
  }
  if (sub === "list") {
    runProfileList(paths.configDir);
    return;
  }
  if (sub === "switch") {
    runProfileSwitch(paths.configDir, tail);
    return;
  }
  if (sub === "delete") {
    runProfileDelete(paths.configDir, tail);
    return;
  }

  throw new Error(`Unknown profile subcommand: ${sub}`);
}
