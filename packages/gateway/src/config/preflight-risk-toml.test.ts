import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";
import {
  DEFAULT_PREFLIGHT_RISK_CONFIG,
  effectivePreflightRiskZone,
  loadNimbusPreflightRiskFromConfigDir,
  parseNimbusTomlPreflightRisk,
  parseQuietWindow,
} from "./preflight-risk-toml.ts";

const dirs: string[] = [];
afterEach(() => {
  resetLayeredConfigsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function parse(src: string): {
  cfg: ReturnType<typeof parseNimbusTomlPreflightRisk>;
  seen: string[];
} {
  const seen: string[] = [];
  return { cfg: parseNimbusTomlPreflightRisk(src, (m) => seen.push(m)), seen };
}

describe("[preflight.risk]", () => {
  test("defaults: Friday after 15:00 and weekends, machine zone, never fails", () => {
    const { cfg, seen } = parse("");
    expect(cfg).toEqual(DEFAULT_PREFLIGHT_RISK_CONFIG);
    expect(cfg.quietDays).toEqual([6, 0]);
    expect(cfg.quietHours.map((w) => w.label)).toEqual(["fri 15:00-24:00"]);
    expect(cfg.failAt).toBeNull();
    expect(cfg.tz).toBeNull();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(seen).toEqual([]);
    expect(effectivePreflightRiskZone(cfg).length).toBeGreaterThan(0);
    expect(effectivePreflightRiskZone({ tz: "Asia/Tokyo" })).toBe("Asia/Tokyo");
  });

  test("a section that is not ours changes nothing", () => {
    expect(parse('[other]\nfail_at = "high"\n').cfg).toEqual(DEFAULT_PREFLIGHT_RISK_CONFIG);
  });

  test("reads every key, with a comment and CRLF", () => {
    const { cfg, seen } = parse(
      '[preflight.risk]\r\nquiet_days = ["Sun"] # rest\r\nquiet_hours = ["thu 16:30-18:00", "fri 09:00-10:15"]\r\ntz = "Europe/Berlin"\r\nfail_at = "high"\r\n',
    );
    expect(cfg.quietDays).toEqual([0]);
    expect(cfg.quietHours.map((w) => w.label)).toEqual(["thu 16:30-18:00", "fri 09:00-10:15"]);
    expect(cfg.tz).toBe("Europe/Berlin");
    expect(cfg.failAt).toBe("high");
    expect(seen).toEqual([]);
  });

  test("empty arrays are valid and mean none", () => {
    const { cfg, seen } = parse("[preflight.risk]\nquiet_days = []\nquiet_hours = []\n");
    expect(cfg.quietDays).toEqual([]);
    expect(cfg.quietHours).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("one trailing comma is valid", () => {
    const { cfg, seen } = parse('[preflight.risk]\nquiet_days = ["sat",]\n');
    expect(cfg.quietDays).toEqual([6]);
    expect(seen).toEqual([]);
  });

  test.each([
    ['quiet_days = ["funday"]', "quiet_days"],
    ['quiet_days = ["sat", ""]', "quiet_days"],
    ['quiet_days = "sat"', "quiet_days"],
    ['quiet_hours = ["fri 15:00"]', "quiet_hours"],
    ['quiet_hours = ["fri 18:00-15:00"]', "quiet_hours"],
    ['quiet_hours = ["fri 15:00-25:00"]', "quiet_hours"],
    ['quiet_hours = ["fri 15:61-16:00"]', "quiet_hours"],
    ['quiet_hours = ["xyz 15:00-16:00"]', "quiet_hours"],
    ['quiet_hours = ["fri 24:00-24:30"]', "quiet_hours"],
    ['quiet_hours = "fri 15:00-16:00"', "quiet_hours"],
  ])("falls back for %s", (line, key) => {
    const { cfg, seen } = parse(`[preflight.risk]\n${line}\n`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(key);
    expect(cfg.quietDays).toEqual(DEFAULT_PREFLIGHT_RISK_CONFIG.quietDays);
    expect(cfg.quietHours).toEqual(DEFAULT_PREFLIGHT_RISK_CONFIG.quietHours);
  });

  test("a bad key never condemns another", () => {
    const { cfg, seen } = parse('[preflight.risk]\nquiet_days = ["x"]\nfail_at = "elevated"\n');
    expect(cfg.failAt).toBe("elevated");
    expect(seen).toHaveLength(1);
  });

  test.each(["low", "never", "1", "HIGH"])("fail_at = %s falls back to unset", (v) => {
    const { cfg, seen } = parse(`[preflight.risk]\nfail_at = "${v}"\n`);
    expect(cfg.failAt).toBeNull();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("fail_at");
  });

  test("an unknown zone falls back to the machine zone", () => {
    const { cfg, seen } = parse('[preflight.risk]\ntz = "Mars/Olympus"\n');
    expect(cfg.tz).toBeNull();
    expect(seen[0]).toContain("tz");
  });

  test("unknown keys are ignored", () => {
    expect(parse("[preflight.risk]\nthreshold = 3\n").seen).toEqual([]);
  });

  test("parseQuietWindow normalises and refuses", () => {
    expect(parseQuietWindow(" FRI 9:05-17:30 ")?.label).toBe("fri 09:05-17:30");
    expect(parseQuietWindow("fri 23:00-24:00")?.endMinute).toBe(1440);
    expect(parseQuietWindow("fri 10:00-10:00")).toBeNull();
    expect(parseQuietWindow("")).toBeNull();
  });

  test("the layered loader reads the config dir and records a fallback for explain", () => {
    const d = mkdtempSync(join(tmpdir(), "nimbus-preflight-risk-"));
    dirs.push(d);
    writeFileSync(join(d, "nimbus.toml"), '[preflight.risk]\nfail_at = "high"\n');
    expect(loadNimbusPreflightRiskFromConfigDir(d).failAt).toBe("high");
    writeFileSync(join(d, "nimbus.toml"), '[preflight.risk]\nfail_at = "nope"\n');
    resetLayeredConfigsForTests();
    const reader = initLayeredConfig(d);
    expect(loadNimbusPreflightRiskFromConfigDir(d).failAt).toBeNull();
    expect(reader.sectionFallback("preflight.risk")).toContain("fail_at");
  });

  test("no config file gives the defaults", () => {
    const d = mkdtempSync(join(tmpdir(), "nimbus-preflight-risk-"));
    dirs.push(d);
    expect(loadNimbusPreflightRiskFromConfigDir(d)).toEqual(DEFAULT_PREFLIGHT_RISK_CONFIG);
  });
});
