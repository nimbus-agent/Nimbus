import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SECTION_LOADERS } from "./config-explain.ts";
import {
  DEFAULT_FINOPS_CONFIG,
  loadNimbusFinopsFromConfigDir,
  parseNimbusTomlFinops,
} from "./finops-toml.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";

const dirs: string[] = [];
afterEach(() => {
  resetLayeredConfigsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-finops-toml-"));
  dirs.push(d);
  return d;
}

describe("[finops] notify keys", () => {
  test("notify defaults off and parses; a bad value falls back and is reported", () => {
    const msgs: string[] = [];
    const sink = (m: string): void => void msgs.push(m);
    expect(
      parseNimbusTomlFinops("[finops]\nnotify = true\nnotify_min_interval_minutes = 5\n"),
    ).toEqual({ ...DEFAULT_FINOPS_CONFIG, notify: true, notifyMinIntervalMinutes: 5 });
    const bad = parseNimbusTomlFinops(
      "[finops]\nnotify = maybe\nnotify_min_interval_minutes = 4\n",
      sink,
    );
    expect(bad.notify).toBe(false);
    expect(bad.notifyMinIntervalMinutes).toBe(360);
    expect(msgs).toHaveLength(2);
  });
});

describe("[finops] config", () => {
  test("an absent section is the defaults: 500 series, 400 days", () => {
    expect(parseNimbusTomlFinops("")).toEqual(DEFAULT_FINOPS_CONFIG);
    expect(parseNimbusTomlFinops("[fleet]\nenabled = true\n")).toEqual(DEFAULT_FINOPS_CONFIG);
    expect(DEFAULT_FINOPS_CONFIG).toEqual({
      maxSeries: 500,
      retainDays: 400,
      anomalyRatio: 1.5,
      anomalyMinAmount: 10,
      notify: false,
      notifyMinIntervalMinutes: 360,
    });
    expect(Object.isFrozen(DEFAULT_FINOPS_CONFIG)).toBe(true);
  });

  test("parses both keys at their bounds", () => {
    expect(parseNimbusTomlFinops("[finops]\nmax_series = 1\nretain_days = 30\n")).toEqual({
      ...DEFAULT_FINOPS_CONFIG,
      maxSeries: 1,
      retainDays: 30,
    });
    expect(parseNimbusTomlFinops("[finops]\nmax_series = 5000\nretain_days = 3650\n")).toEqual({
      ...DEFAULT_FINOPS_CONFIG,
      maxSeries: 5000,
      retainDays: 3650,
    });
  });

  test("an out-of-range or non-integer value falls back to the default and is reported, never clamped", () => {
    const seen: string[] = [];
    const cfg = parseNimbusTomlFinops("[finops]\nmax_series = 5001\nretain_days = 29\n", (m) =>
      seen.push(m),
    );
    expect(cfg).toEqual(DEFAULT_FINOPS_CONFIG);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toContain("[finops].max_series");
    expect(seen[1]).toContain("[finops].retain_days");
    for (const bad of ["0", "-5", "1.5", '"abc"', "true"]) {
      expect(parseNimbusTomlFinops(`[finops]\nmax_series = ${bad}\n`).maxSeries).toBe(500);
      expect(parseNimbusTomlFinops(`[finops]\nretain_days = ${bad}\n`).retainDays).toBe(400);
    }
  });

  test("a bad key does not condemn the other, and an unknown key or another table is ignored", () => {
    const cfg = parseNimbusTomlFinops(
      "[finops]\nmax_series = 7\nretain_days = 1\nother = 3\n[finops.x]\nmax_series = 9\n",
    );
    expect(cfg).toEqual({ ...DEFAULT_FINOPS_CONFIG, maxSeries: 7 });
  });

  test("anomaly_ratio and anomaly_min_amount parse decimals at their bounds", () => {
    expect(
      parseNimbusTomlFinops("[finops]\nanomaly_ratio = 2.25\nanomaly_min_amount = 0\n"),
    ).toEqual({ ...DEFAULT_FINOPS_CONFIG, anomalyRatio: 2.25, anomalyMinAmount: 0 });
    expect(
      parseNimbusTomlFinops("[finops]\nanomaly_ratio = 100\nanomaly_min_amount = 12.5\n"),
    ).toEqual({ ...DEFAULT_FINOPS_CONFIG, anomalyRatio: 100, anomalyMinAmount: 12.5 });
  });

  test("a bad anomaly threshold falls back to its default and is reported", () => {
    const seen: string[] = [];
    const report = (m: string): void => {
      seen.push(m);
    };
    for (const bad of ["1.04", "101", "-1", '"x"', "1e2", "true"]) {
      const cfg = parseNimbusTomlFinops(
        ["[finops]", `anomaly_ratio = ${bad}`, ""].join("\n"),
        report,
      );
      expect(cfg.anomalyRatio).toBe(1.5);
    }
    for (const bad of ["-1", "1000000001", "abc"]) {
      const cfg = parseNimbusTomlFinops(
        ["[finops]", `anomaly_min_amount = ${bad}`, ""].join("\n"),
        report,
      );
      expect(cfg.anomalyMinAmount).toBe(10);
    }
    expect(seen).toHaveLength(9);
    expect(seen[0]).toContain("[finops].anomaly_ratio");
  });

  test("the layered loader reads the config dir; an absent file is the defaults", () => {
    const d = tmp();
    expect(loadNimbusFinopsFromConfigDir(d)).toEqual(DEFAULT_FINOPS_CONFIG);
    writeFileSync(join(d, "nimbus.toml"), "[finops]\nmax_series = 20\n");
    resetLayeredConfigsForTests();
    initLayeredConfig(d);
    expect(loadNimbusFinopsFromConfigDir(d).maxSeries).toBe(20);
  });

  test("the section is registered for config explain", () => {
    expect("finops" in SECTION_LOADERS).toBe(true);
    expect(SECTION_LOADERS["finops"]?.(tmp())).toEqual(DEFAULT_FINOPS_CONFIG);
  });
});
