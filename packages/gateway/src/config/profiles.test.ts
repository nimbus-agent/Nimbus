import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./profiles.ts";

describe("ProfileManager", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-profiles-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("list returns empty array before any profile is created", () => {
    const mgr = new ProfileManager(dir);
    expect(mgr.list()).toEqual([]);
    expect(mgr.getActive()).toBeUndefined();
  });

  test("create + switch + list round trip", () => {
    const mgr = new ProfileManager(dir);
    mgr.create("work");
    mgr.create("personal");
    mgr.switchTo("personal");
    const profiles = mgr.list();
    expect(profiles.map((p) => p.name).sort((a, b) => a.localeCompare(b))).toEqual([
      "personal",
      "work",
    ]);
    expect(profiles.find((p) => p.active)?.name).toBe("personal");
  });

  test("delete removes the profile file and clears active if needed", () => {
    const mgr = new ProfileManager(dir);
    mgr.create("work");
    mgr.create("personal");
    mgr.switchTo("work");
    mgr.delete("personal");
    const profiles = mgr.list();
    expect(profiles.map((p) => p.name)).toEqual(["work"]);
  });

  test("delete refuses the active profile", () => {
    const mgr = new ProfileManager(dir);
    mgr.create("work");
    mgr.switchTo("work");
    expect(() => mgr.delete("work")).toThrow(/active/i);
  });

  test("create rejects invalid names", () => {
    const mgr = new ProfileManager(dir);
    expect(() => mgr.create("bad name!")).toThrow();
    expect(() => mgr.create("default")).toThrow();
  });

  test("vaultKeyPrefix returns empty string for default profile", () => {
    const mgr = new ProfileManager(dir);
    expect(mgr.vaultKeyPrefix()).toBe("");
  });

  test("vaultKeyPrefix returns profile/ prefix after switch", () => {
    const mgr = new ProfileManager(dir);
    mgr.create("work");
    mgr.switchTo("work");
    expect(mgr.vaultKeyPrefix()).toBe("profile/work/");
  });
});
