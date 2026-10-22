import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InvalidProfileNameError,
  profileFilePath,
  resolveActiveProfile,
} from "./active-profile.ts";

const dirs: string[] = [];

function freshDir(marker?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-active-profile-"));
  dirs.push(dir);
  if (marker !== undefined) writeFileSync(join(dir, ".nimbus-profile"), marker, "utf8");
  return dir;
}

function envOf(map: Record<string, string>): (k: string) => string | undefined {
  return (k) => map[k];
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("resolveActiveProfile", () => {
  test("explicit beats env and marker", () => {
    const configDir = freshDir("c\n");
    const r = resolveActiveProfile({
      configDir,
      explicit: "a",
      env: envOf({ NIMBUS_PROFILE: "b" }),
    });
    expect(r).toEqual({ name: "a", source: "argument" });
  });

  test("env beats marker", () => {
    const configDir = freshDir("c\n");
    const r = resolveActiveProfile({ configDir, env: envOf({ NIMBUS_PROFILE: "b" }) });
    expect(r).toEqual({ name: "b", source: "env" });
  });

  test("marker used when env unset", () => {
    const configDir = freshDir("work\n");
    expect(resolveActiveProfile({ configDir, env: envOf({}) })).toEqual({
      name: "work",
      source: "marker",
    });
  });

  test('env "default" falls through to marker', () => {
    const configDir = freshDir("work");
    const r = resolveActiveProfile({ configDir, env: envOf({ NIMBUS_PROFILE: "default" }) });
    expect(r).toEqual({ name: "work", source: "marker" });
  });

  test("nothing set is default", () => {
    const configDir = freshDir();
    expect(resolveActiveProfile({ configDir, env: envOf({}) })).toEqual({
      name: "default",
      source: "default",
    });
  });

  test("traversal in marker throws", () => {
    const configDir = freshDir("../x");
    try {
      resolveActiveProfile({ configDir, env: envOf({}) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidProfileNameError);
      const err = e as InvalidProfileNameError;
      expect(err.value).toBe("../x");
      expect(err.source).toBe("marker");
    }
  });

  test("over-long env name throws", () => {
    const configDir = freshDir();
    try {
      resolveActiveProfile({ configDir, env: envOf({ NIMBUS_PROFILE: "a".repeat(33) }) });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidProfileNameError);
      expect((e as InvalidProfileNameError).source).toBe("env");
    }
  });
});

describe("profileFilePath", () => {
  test("null for default, nimbus.<name>.toml otherwise", () => {
    const dir = freshDir();
    expect(profileFilePath(dir, "default")).toBeNull();
    expect(profileFilePath(dir, "work")).toBe(join(dir, "nimbus.work.toml"));
  });
});

test("resolveNimbusTomlForProfile is gone", () => {
  const src = readFileSync(join(import.meta.dir, "nimbus-toml.ts"), "utf8");
  expect(src).not.toContain("resolveNimbusTomlForProfile");
});
