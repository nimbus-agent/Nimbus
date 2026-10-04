import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileManager } from "./profiles.ts";

/**
 * `ProfileManager` edges `profiles.test.ts` leaves out: a config dir that does not exist yet, an
 * active-profile marker that names the default profile (or nothing), a config dir that vanished
 * after construction, and the two "not found"/"not EEXIST" refusals — each asserted to fail with
 * its OWN message, never a sibling's.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-profiles-cov-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ProfileManager — construction", () => {
  test("creates a missing config dir, nested levels included", () => {
    const configDir = join(root, "nested", "config");
    expect(existsSync(configDir)).toBe(false);

    const mgr = new ProfileManager(configDir);

    expect(statSync(configDir).isDirectory()).toBe(true);
    expect(mgr.list()).toEqual([]);
  });
});

describe("ProfileManager — the active-profile marker", () => {
  for (const [label, contents] of [
    ["names the default profile", "default\n"],
    ["is empty", ""],
    ["is only whitespace", "  \n"],
  ] as const) {
    test(`a marker that ${label} means no profile is active`, () => {
      const mgr = new ProfileManager(root);
      mgr.create("work");
      writeFileSync(join(root, ".nimbus-profile"), contents, "utf8");

      expect(mgr.getActive()).toBeUndefined();
      expect(mgr.vaultKeyPrefix()).toBe("");
      expect(mgr.list()).toEqual([{ name: "work", active: false }]);
      // Nothing is active, so nothing is protected from deletion.
      expect(() => mgr.delete("work")).not.toThrow();
    });
  }
});

describe("ProfileManager — a config dir that vanished after construction", () => {
  test("list() reports no profiles instead of throwing", () => {
    const configDir = join(root, "cfg");
    const mgr = new ProfileManager(configDir);
    mgr.create("work");
    rmSync(configDir, { recursive: true, force: true });

    expect(mgr.list()).toEqual([]);
    expect(mgr.getActive()).toBeUndefined();
  });

  test("create() surfaces the real filesystem error, not 'already exists'", () => {
    const configDir = join(root, "cfg");
    const mgr = new ProfileManager(configDir);
    rmSync(configDir, { recursive: true, force: true });

    let caught: unknown;
    try {
      mgr.create("work");
    } catch (e) {
      caught = e;
    }
    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    expect((caught as Error).message).not.toContain("already exists");
  });
});

describe("ProfileManager — refusals name their own cause", () => {
  test("creating a profile twice is 'already exists'", () => {
    const mgr = new ProfileManager(root);
    mgr.create("work");
    expect(() => mgr.create("work")).toThrow("Profile already exists: work");
  });

  test("deleting an unknown profile is 'not found', not 'active'", () => {
    const mgr = new ProfileManager(root);
    let message = "";
    try {
      mgr.delete("ghost");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe("Profile not found: ghost");
  });

  test("switching to an unknown profile is 'not found' and writes no marker", () => {
    const mgr = new ProfileManager(root);
    expect(() => mgr.switchTo("ghost")).toThrow("Profile not found: ghost");
    expect(existsSync(join(root, ".nimbus-profile"))).toBe(false);
  });
});
