import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_INDEX_CONFIG,
  loadNimbusIndexFromConfigDir,
  parseNimbusTomlIndex,
} from "./index-toml.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";

const dirs: string[] = [];
afterEach(() => {
  resetLayeredConfigsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-index-toml-"));
  dirs.push(d);
  return d;
}

describe("[index] history_retention_days", () => {
  test("defaults to 180 with no file or no section, and the result is frozen", () => {
    const c = parseNimbusTomlIndex("");
    expect(c).toEqual(DEFAULT_INDEX_CONFIG);
    expect(c.historyRetentionDays).toBe(180);
    expect(Object.isFrozen(c)).toBe(true);
    expect(
      parseNimbusTomlIndex("[other]\nhistory_retention_days = 30\n").historyRetentionDays,
    ).toBe(180);
  });

  test.each([
    ["a plain value", "[index]\nhistory_retention_days = 30\n", 30],
    ["the lower bound", "[index]\nhistory_retention_days = 7\n", 7],
    ["the upper bound", "[index]\nhistory_retention_days = 3650\n", 3650],
    ["an inline comment", "[index]\nhistory_retention_days = 45 # a month and a half\n", 45],
    ["CRLF line endings", "[index]\r\nhistory_retention_days = 60\r\n", 60],
    ["unknown keys ignored", "[index]\nfuture_key = 1\nhistory_retention_days = 20\n", 20],
    ["a sub-table does not leak", "[index.other]\nhistory_retention_days = 20\n", 180],
    ["a later section does not leak", "[index]\n[llm]\nhistory_retention_days = 20\n", 180],
  ])("%s", (_label, toml, expected) => {
    expect(parseNimbusTomlIndex(toml).historyRetentionDays).toBe(expected);
  });

  test.each([
    ["below the floor", "6"],
    ["above the ceiling", "3651"],
    ["zero (not a disabled mode)", "0"],
    ["negative", "-1"],
    ["not a number", "abc"],
    ["a fraction", "1.5"],
    ["a quoted number", '"30"'],
  ])("%s falls back to 180 and reports the key and the range", (_label, raw) => {
    const seen: string[] = [];
    const c = parseNimbusTomlIndex(`[index]\nhistory_retention_days = ${raw}\n`, (m) =>
      seen.push(m),
    );
    expect(c.historyRetentionDays).toBe(180);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("history_retention_days");
    expect(seen[0]).toContain("7..3650");
  });

  test("a line in [index] that is not key = value is ignored", () => {
    expect(
      parseNimbusTomlIndex("[index]\nnot a pair\nhistory_retention_days = 12\n")
        .historyRetentionDays,
    ).toBe(12);
  });

  test("an out-of-range value works without a fallback sink", () => {
    expect(parseNimbusTomlIndex("[index]\nhistory_retention_days = 1\n").historyRetentionDays).toBe(
      180,
    );
  });

  test("the layered loader reads the config dir and records the fallback for explain", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[index]\nhistory_retention_days = 30\n");
    expect(loadNimbusIndexFromConfigDir(d).historyRetentionDays).toBe(30);
    writeFileSync(join(d, "nimbus.toml"), "[index]\nhistory_retention_days = 1\n");
    resetLayeredConfigsForTests();
    const reader = initLayeredConfig(d);
    expect(loadNimbusIndexFromConfigDir(d).historyRetentionDays).toBe(180);
    expect(reader.sectionFallback("index")).toContain("history_retention_days");
  });

  test("no file gives the default", () => {
    expect(loadNimbusIndexFromConfigDir(tmp())).toEqual(DEFAULT_INDEX_CONFIG);
  });
});
