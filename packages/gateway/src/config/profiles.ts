import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROFILE_MARKER = ".nimbus-profile";
const PROFILE_PREFIX = "nimbus.";
const PROFILE_SUFFIX = ".toml";

export type ProfileSummary = { name: string; active: boolean };

export class ProfileManager {
  private readonly configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  }

  private readActiveMarker(): string | undefined {
    const path = join(this.configDir, PROFILE_MARKER);
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8").trim();
    if (raw === "" || raw === "default") return undefined;
    return raw;
  }

  private profileTomlPath(name: string): string {
    return join(this.configDir, `${PROFILE_PREFIX}${name}${PROFILE_SUFFIX}`);
  }

  private listProfileNames(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.configDir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const n of names) {
      if (n.startsWith(PROFILE_PREFIX) && n.endsWith(PROFILE_SUFFIX) && n !== "nimbus.toml") {
        out.push(n.slice(PROFILE_PREFIX.length, -PROFILE_SUFFIX.length));
      }
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  list(): ProfileSummary[] {
    const active = this.readActiveMarker();
    return this.listProfileNames().map((name) => ({ name, active: name === active }));
  }

  getActive(): string | undefined {
    return this.readActiveMarker();
  }

  create(name: string): void {
    if (!/^[a-z0-9_-]{1,32}$/i.test(name) || name === "default") {
      throw new Error(`Invalid profile name: ${name}`);
    }
    const dest = this.profileTomlPath(name);
    try {
      writeFileSync(dest, `schema_version = 1\nprofile_name = "${name}"\n`, {
        encoding: "utf8",
        flag: "wx",
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Profile already exists: ${name}`);
      }
      throw err;
    }
  }

  switchTo(name: string): void {
    const dest = this.profileTomlPath(name);
    if (!existsSync(dest)) throw new Error(`Profile not found: ${name}`);
    writeFileSync(join(this.configDir, PROFILE_MARKER), `${name}\n`, "utf8");
  }

  delete(name: string): void {
    if (this.readActiveMarker() === name) {
      throw new Error(`Cannot delete active profile: ${name}`);
    }
    const dest = this.profileTomlPath(name);
    if (!existsSync(dest)) throw new Error(`Profile not found: ${name}`);
    rmSync(dest, { force: true });
  }

  vaultKeyPrefix(): string {
    const active = this.readActiveMarker();
    return active === undefined ? "" : `profile/${active}/`;
  }
}
