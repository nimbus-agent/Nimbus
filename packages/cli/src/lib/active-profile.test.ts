import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cliWriteTargetPath, PROFILE_NAME_RE, resolveCliActiveProfile } from "./active-profile.ts";

describe("cli active profile", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-cli-profile-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const noEnv = (): undefined => undefined;
  const envWith = (v: string) => (k: string) => (k === "NIMBUS_PROFILE" ? v : undefined);

  it("defaults when nothing is set", () => {
    expect(resolveCliActiveProfile(dir, noEnv)).toBe("default");
    expect(cliWriteTargetPath(dir, noEnv)).toBe(join(dir, "nimbus.toml"));
  });

  it("env wins over the marker", () => {
    writeFileSync(join(dir, ".nimbus-profile"), "home\n");
    expect(resolveCliActiveProfile(dir, envWith("work"))).toBe("work");
  });

  it("uses the trimmed marker, even for a missing profile file", () => {
    writeFileSync(join(dir, ".nimbus-profile"), "  work \n");
    expect(resolveCliActiveProfile(dir, noEnv)).toBe("work");
    expect(cliWriteTargetPath(dir, noEnv)).toBe(join(dir, "nimbus.work.toml"));
  });

  it("treats a blank env and a default marker as default", () => {
    writeFileSync(join(dir, ".nimbus-profile"), "default");
    expect(resolveCliActiveProfile(dir, envWith("  "))).toBe("default");
  });

  it("rejects an invalid name, naming it", () => {
    expect(() => resolveCliActiveProfile(dir, envWith("../evil"))).toThrow(/evil/);
    expect(PROFILE_NAME_RE.test("a".repeat(33))).toBe(false);
    expect(PROFILE_NAME_RE.test("Work_1-b")).toBe(true);
  });
});
