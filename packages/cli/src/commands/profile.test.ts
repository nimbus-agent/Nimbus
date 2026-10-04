import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { getCliPlatformPaths } from "../paths.ts";

const profileMod = await import("./profile.ts");
const { runProfile, runProfileCreate, runProfileDelete, runProfileList, runProfileSwitch } =
  profileMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

function makeTmpConfigDir(): string {
  return mkdtempSync(join(tmpdir(), "nimbus-cli-profile-"));
}

describe("runProfileCreate", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmpConfigDir();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("copies nimbus.toml to nimbus.<name>.toml when the base exists", () => {
    const base = join(tmp, "nimbus.toml");
    writeFileSync(base, '# base\nfoo = "bar"\n', "utf8");
    runProfileCreate(tmp, base, ["work"]);
    const dest = join(tmp, "nimbus.work.toml");
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toContain('foo = "bar"');
    expect(out.stdout).toContain(`Created ${dest}`);
  });

  it("seeds a minimal profile file when the base nimbus.toml is missing", () => {
    const base = join(tmp, "nimbus.toml");
    runProfileCreate(tmp, base, ["personal"]);
    const dest = join(tmp, "nimbus.personal.toml");
    expect(existsSync(dest)).toBe(true);
    const body = readFileSync(dest, "utf8");
    expect(body).toContain("schema_version = 1");
    expect(body).toContain('profile_name = "personal"');
  });

  it("throws when the dest profile file already exists", () => {
    const base = join(tmp, "nimbus.toml");
    writeFileSync(base, "", "utf8");
    writeFileSync(join(tmp, "nimbus.work.toml"), "existing", "utf8");
    expect(() => runProfileCreate(tmp, base, ["work"])).toThrow("already exists");
  });

  it("rejects empty / 'default' names", () => {
    const base = join(tmp, "nimbus.toml");
    expect(() => runProfileCreate(tmp, base, [])).toThrow("Usage: nimbus profile create");
    expect(() => runProfileCreate(tmp, base, ["default"])).toThrow("Usage: nimbus profile create");
  });

  // The minimal-file fallback is for a MISSING base (ENOENT) only: any other copy failure has to
  // surface as itself, not be swallowed into a seeded profile the owner never asked for. A NUL byte
  // in the base path fails argument validation with the same code on every OS, where a real
  // filesystem error's code differs by platform.
  it("rethrows a copy failure that is neither EEXIST nor ENOENT, and seeds nothing", () => {
    let thrown: unknown;
    try {
      runProfileCreate(tmp, join(tmp, "nim\0bus.toml"), ["work"]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as { code?: unknown }).code).toBe("ERR_INVALID_ARG_VALUE");
    expect((thrown as Error).message).not.toContain("already exists");
    expect(existsSync(join(tmp, "nimbus.work.toml"))).toBe(false);
    expect(out.stdout).toBe("");
  });
});

describe("runProfileList", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmpConfigDir();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("shows default active profile and 'no profiles yet' when none exist", () => {
    runProfileList(tmp);
    expect(out.stdout).toContain("active: (default — nimbus.toml)");
    expect(out.stdout).toContain("(no nimbus.<name>.toml profiles yet)");
  });

  it("lists profile files alphabetically and marks the active one with '*'", () => {
    writeFileSync(join(tmp, "nimbus.work.toml"), "", "utf8");
    writeFileSync(join(tmp, "nimbus.personal.toml"), "", "utf8");
    writeFileSync(join(tmp, ".nimbus-profile"), "work\n", "utf8");
    runProfileList(tmp);
    expect(out.stdout).toContain("active: work");
    const personalIdx = out.stdout.indexOf("  personal");
    const workIdx = out.stdout.indexOf("* work");
    expect(personalIdx).toBeGreaterThan(-1);
    expect(workIdx).toBeGreaterThan(-1);
    expect(personalIdx).toBeLessThan(workIdx);
  });

  it("ignores nimbus.toml (base file) when listing profile files", () => {
    writeFileSync(join(tmp, "nimbus.toml"), "", "utf8");
    runProfileList(tmp);
    expect(out.stdout).toContain("(no nimbus.<name>.toml profiles yet)");
  });

  it("treats '.nimbus-profile' content of 'default' / empty as no override", () => {
    writeFileSync(join(tmp, ".nimbus-profile"), "default\n", "utf8");
    runProfileList(tmp);
    expect(out.stdout).toContain("active: (default — nimbus.toml)");
  });
});

describe("runProfileSwitch", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmpConfigDir();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("writes .nimbus-profile when the profile file exists", () => {
    writeFileSync(join(tmp, "nimbus.work.toml"), "", "utf8");
    runProfileSwitch(tmp, ["work"]);
    expect(readFileSync(join(tmp, ".nimbus-profile"), "utf8")).toBe("work\n");
    expect(out.stdout).toContain('Active profile set to "work"');
  });

  it("removes .nimbus-profile when switching to 'default'", () => {
    writeFileSync(join(tmp, ".nimbus-profile"), "work\n", "utf8");
    runProfileSwitch(tmp, ["default"]);
    expect(existsSync(join(tmp, ".nimbus-profile"))).toBe(false);
    expect(out.stdout).toContain("Switched to default profile");
  });

  it("throws when the profile file is missing", () => {
    expect(() => runProfileSwitch(tmp, ["missing"])).toThrow("Unknown profile file");
  });

  it("rejects empty name", () => {
    expect(() => runProfileSwitch(tmp, [])).toThrow("Usage: nimbus profile switch");
  });
});

describe("runProfileDelete", () => {
  let tmp: string;
  beforeEach(() => {
    out.reset();
    tmp = makeTmpConfigDir();
  });
  afterEach(() => {
    clearFixture();
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("deletes the profile file when --yes is given", () => {
    const dest = join(tmp, "nimbus.work.toml");
    writeFileSync(dest, "", "utf8");
    runProfileDelete(tmp, ["work", "--yes"]);
    expect(existsSync(dest)).toBe(false);
    expect(out.stdout).toContain("Deleted profile work");
  });

  it("also clears .nimbus-profile when deleting the active profile", () => {
    writeFileSync(join(tmp, "nimbus.work.toml"), "", "utf8");
    writeFileSync(join(tmp, ".nimbus-profile"), "work\n", "utf8");
    runProfileDelete(tmp, ["work", "--yes"]);
    expect(existsSync(join(tmp, ".nimbus-profile"))).toBe(false);
  });

  it("leaves .nimbus-profile intact when deleting an inactive profile", () => {
    writeFileSync(join(tmp, "nimbus.work.toml"), "", "utf8");
    writeFileSync(join(tmp, "nimbus.personal.toml"), "", "utf8");
    writeFileSync(join(tmp, ".nimbus-profile"), "work\n", "utf8");
    runProfileDelete(tmp, ["personal", "--yes"]);
    expect(readFileSync(join(tmp, ".nimbus-profile"), "utf8")).toBe("work\n");
  });

  it("rejects without --yes", () => {
    expect(() => runProfileDelete(tmp, ["work"])).toThrow("Usage: nimbus profile delete");
  });

  it("throws when the file is missing", () => {
    expect(() => runProfileDelete(tmp, ["missing", "--yes"])).toThrow("Unknown profile file");
  });
});

describe("runProfile (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints help with no args", () => {
    runProfile([]);
    expect(out.stdout).toContain("nimbus profile");
  });

  it("prints help on '--help' / '-h' / 'help'", () => {
    runProfile(["help"]);
    expect(out.stdout).toContain("nimbus profile");
    out.reset();
    runProfile(["--help"]);
    expect(out.stdout).toContain("nimbus profile");
    out.reset();
    runProfile(["-h"]);
    expect(out.stdout).toContain("nimbus profile");
  });

  it("rejects unknown subcommands", () => {
    expect(() => runProfile(["bogus"])).toThrow("Unknown profile subcommand: bogus");
  });
});

describe("runProfileList / runProfileDelete -- the edges", () => {
  beforeEach(() => {
    out.reset();
  });

  it("a config dir that does not exist yet lists as the default with no profiles, not a crash", () => {
    const root = makeTmpConfigDir();
    try {
      runProfileList(join(root, "never-created"));
      expect(out.stdout).toBe(
        "active: (default — nimbus.toml)\n(no nimbus.<name>.toml profiles yet)\n",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delete with no arguments at all is a usage error that touches nothing", () => {
    const root = makeTmpConfigDir();
    try {
      writeFileSync(join(root, ".nimbus-profile"), "work\n", "utf8");
      expect(() => runProfileDelete(root, [])).toThrow("Usage: nimbus profile delete <name> --yes");
      expect(readFileSync(join(root, ".nimbus-profile"), "utf8")).toBe("work\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runProfile (dispatcher) -- each subcommand acts on the CONFIGURED config dir", () => {
  let tmp: string;
  let savedConfigDir: string | undefined;
  let savedDemo: string | undefined;

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  beforeEach(() => {
    out.reset();
    tmp = makeTmpConfigDir();
    savedConfigDir = process.env["NIMBUS_CONFIG_DIR"];
    savedDemo = process.env["NIMBUS_DEMO"];
    process.env["NIMBUS_CONFIG_DIR"] = tmp;
    delete process.env["NIMBUS_DEMO"];
    // Precondition: every write below resolves into tmp. Were the override not honoured, this
    // fails before the test writes a single file into the developer's real config dir.
    expect(getCliPlatformPaths().configDir).toBe(tmp);
  });

  afterEach(() => {
    restoreEnv("NIMBUS_CONFIG_DIR", savedConfigDir);
    restoreEnv("NIMBUS_DEMO", savedDemo);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("create -> switch -> list -> delete, end to end", () => {
    writeFileSync(join(tmp, "nimbus.toml"), 'foo = "bar"\n', "utf8");

    runProfile(["create", "work"]);
    expect(readFileSync(join(tmp, "nimbus.work.toml"), "utf8")).toBe('foo = "bar"\n');

    runProfile(["switch", "work"]);
    expect(readFileSync(join(tmp, ".nimbus-profile"), "utf8")).toBe("work\n");

    out.reset();
    runProfile(["list"]);
    expect(out.stdout).toBe("active: work\n* work\n");

    runProfile(["delete", "work", "--yes"]);
    expect(existsSync(join(tmp, "nimbus.work.toml"))).toBe(false);
    // Deleting the ACTIVE profile also drops the marker, or `nimbus start` would load a ghost.
    expect(existsSync(join(tmp, ".nimbus-profile"))).toBe(false);
    // The base file is never touched by any of it.
    expect(readFileSync(join(tmp, "nimbus.toml"), "utf8")).toBe('foo = "bar"\n');
  });
});
