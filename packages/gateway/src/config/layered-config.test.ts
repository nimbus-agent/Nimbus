import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidProfileNameError, resolveActiveProfile } from "./active-profile.ts";
import {
  getLayeredConfig,
  initLayeredConfig,
  LayeredConfig,
  resetLayeredConfigsForTests,
} from "./layered-config.ts";

describe("LayeredConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-layered-"));
  });
  afterEach(() => {
    resetLayeredConfigsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  const work = () =>
    new LayeredConfig({ configDir: dir, profile: { name: "work", source: "argument" } });
  const dflt = () =>
    new LayeredConfig({ configDir: dir, profile: { name: "default", source: "default" } });

  test("profile inherits base", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n[chatops]\nenabled = true\n");
    write("nimbus.work.toml", "[decisions]\nmin_confidence = 0.6\n");
    const text = work().snapshot().text ?? "";
    expect(text).toContain("0.6");
    expect(text).toContain("[chatops]");
  });

  test("profile without a file reads base and targets the profile file", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n");
    const base = dflt().snapshot().text;
    const cfg = work();
    expect(cfg.snapshot().text).toBe(base);
    expect(cfg.writeTargetPath()).toBe(join(dir, "nimbus.work.toml"));
    expect(dflt().writeTargetPath()).toBe(join(dir, "nimbus.toml"));
  });

  test("no files gives null text", () => {
    expect(dflt().snapshot().text).toBeNull();
  });

  test("same-size rewrite is seen without a restart", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    const a = cfg.snapshot();
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.8\n");
    const b = cfg.snapshot();
    expect(b.text).toContain("0.8");
    expect(b.version).toBe(a.version + 1);
  });

  test("unchanged files keep the version", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    const a = cfg.snapshot();
    const b = cfg.snapshot();
    expect(b.version).toBe(a.version);
    expect(b).toBe(a);
  });

  test("a file appearing or disappearing bumps the version", () => {
    const cfg = dflt();
    const a = cfg.snapshot();
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const b = cfg.snapshot();
    expect(b.version).toBe(a.version + 1);
    rmSync(join(dir, "nimbus.toml"));
    const c = cfg.snapshot();
    expect(c.version).toBe(b.version + 1);
    expect(c.text).toBeNull();
  });

  test("pinned profile ignores a later marker change", () => {
    write(".nimbus-profile", "work");
    const cfg = initLayeredConfig(dir, {});
    expect(cfg.profile.name).toBe("work");
    write(".nimbus-profile", "home");
    expect(cfg.profile.name).toBe("work");
    expect(cfg.markerProfile()).toBe("home");
    expect(getLayeredConfig(dir)).toBe(cfg);
  });

  test("init twice with a different profile throws", () => {
    initLayeredConfig(dir, { explicitProfile: "work" });
    expect(() => initLayeredConfig(dir, { explicitProfile: "home" })).toThrow();
    const same = initLayeredConfig(dir, { explicitProfile: "work" });
    expect(same.profile.name).toBe(resolveActiveProfile({ configDir: dir, explicit: "work" }).name);
  });

  test("section fallback is cleared on change", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    cfg.snapshot();
    cfg.recordSectionFallback("decisions", "bad");
    expect(cfg.sectionFallback("decisions")).toBe("bad");
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.9\n");
    cfg.snapshot();
    expect(cfg.sectionFallback("decisions")).toBeUndefined();
  });
});

describe("initLayeredConfig with an invalid profile", () => {
  test("throws InvalidProfileNameError naming the value and the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-layered-bad-"));
    try {
      let caught: unknown;
      try {
        initLayeredConfig(dir, { explicitProfile: "bad name!" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidProfileNameError);
      const err = caught as InvalidProfileNameError;
      expect(err.message).toContain("bad name!");
      expect(err.message).toContain("argument");
      expect(err.value).toBe("bad name!");
      expect(err.source).toBe("argument");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
