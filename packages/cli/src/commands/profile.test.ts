import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";

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
