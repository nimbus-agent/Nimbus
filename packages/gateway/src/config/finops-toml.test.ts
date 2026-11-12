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

describe("[finops] config", () => {
  test("an absent section is the defaults: 500 series, 400 days", () => {
    expect(parseNimbusTomlFinops("")).toEqual(DEFAULT_FINOPS_CONFIG);
    expect(parseNimbusTomlFinops("[fleet]\nenabled = true\n")).toEqual(DEFAULT_FINOPS_CONFIG);
    expect(DEFAULT_FINOPS_CONFIG).toEqual({ maxSeries: 500, retainDays: 400 });
    expect(Object.isFrozen(DEFAULT_FINOPS_CONFIG)).toBe(true);
  });

  test("parses both keys at their bounds", () => {
    expect(parseNimbusTomlFinops("[finops]\nmax_series = 1\nretain_days = 30\n")).toEqual({
      maxSeries: 1,
      retainDays: 30,
    });
    expect(parseNimbusTomlFinops("[finops]\nmax_series = 5000\nretain_days = 3650\n")).toEqual({
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
    expect(cfg).toEqual({ maxSeries: 7, retainDays: 400 });
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
