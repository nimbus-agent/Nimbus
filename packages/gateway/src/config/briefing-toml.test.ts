import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BRIEFING_SECTIONS,
  DEFAULT_BRIEFING_CONFIG,
  effectiveBriefingZone,
  loadNimbusBriefingFromConfigDir,
  parseNimbusTomlBriefing,
} from "./briefing-toml.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";

const dirs: string[] = [];
afterEach(() => {
  resetLayeredConfigsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-briefing-toml-"));
  dirs.push(d);
  return d;
}

describe("[briefing] snapshot_interval_minutes", () => {
  test("defaults to 15 with no file or no section, and the result is frozen", () => {
    const c = parseNimbusTomlBriefing("");
    expect(c).toEqual(DEFAULT_BRIEFING_CONFIG);
    expect(c.snapshotIntervalMinutes).toBe(15);
    expect(Object.isFrozen(c)).toBe(true);
    expect(parseNimbusTomlBriefing("[other]\nsnapshot_interval_minutes = 99\n")).toEqual(
      DEFAULT_BRIEFING_CONFIG,
    );
  });

  test.each([
    ["a plain value", "[briefing]\nsnapshot_interval_minutes = 30\n", 30],
    ["the lower bound", "[briefing]\nsnapshot_interval_minutes = 5\n", 5],
    ["the upper bound", "[briefing]\nsnapshot_interval_minutes = 240\n", 240],
    ["an inline comment", "[briefing]\nsnapshot_interval_minutes = 20 # twenty\n", 20],
    ["CRLF", "[briefing]\r\nsnapshot_interval_minutes = 45\r\n", 45],
    [
      "a nested table that must not leak",
      "[briefing.deadlines]\nsnapshot_interval_minutes = 99\n[briefing]\nsnapshot_interval_minutes = 10\n",
      10,
    ],
    ["unknown keys ignored", '[briefing]\nsend_at = "07:30"\nsnapshot_interval_minutes = 12\n', 12],
  ])("reads %s", (_l, src, expected) => {
    const seen: string[] = [];
    expect(parseNimbusTomlBriefing(src, (m) => seen.push(m)).snapshotIntervalMinutes).toBe(
      expected,
    );
    expect(seen).toEqual([]);
  });

  test.each(["4", "241", "0", "-1", "abc", "1.5", '"15"'])(
    "falls back to 15 and reports %s",
    (v) => {
      const seen: string[] = [];
      const c = parseNimbusTomlBriefing(`[briefing]\nsnapshot_interval_minutes = ${v}\n`, (m) =>
        seen.push(m),
      );
      expect(c.snapshotIntervalMinutes).toBe(15);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("snapshot_interval_minutes");
    },
  );

  test("the layered loader reads the config dir and records the fallback for explain", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[briefing]\nsnapshot_interval_minutes = 30\n");
    expect(loadNimbusBriefingFromConfigDir(d).snapshotIntervalMinutes).toBe(30);
    writeFileSync(join(d, "nimbus.toml"), "[briefing]\nsnapshot_interval_minutes = 1\n");
    resetLayeredConfigsForTests();
    const reader = initLayeredConfig(d);
    expect(loadNimbusBriefingFromConfigDir(d).snapshotIntervalMinutes).toBe(15);
    expect(reader.sectionFallback("briefing")).toContain("snapshot_interval_minutes");
  });

  test("no file gives the default", () => {
    expect(loadNimbusBriefingFromConfigDir(tmp())).toEqual(DEFAULT_BRIEFING_CONFIG);
  });
});

describe("[briefing] MB5 keys", () => {
  test("defaults", () => {
    const c = parseNimbusTomlBriefing("");
    expect(c.enabled).toBe(false);
    expect(c.schedule).toBe("30 8 * * 1-5");
    expect(c.tz).toBeNull();
    expect(c.sections).toEqual([...BRIEFING_SECTIONS]);
    expect(c.retentionDays).toBe(30);
    expect(c.snapshotIntervalMinutes).toBe(15);
    expect(c.deadlines).toEqual({ enabled: false, leadHours: 24, quietHours: 24 });
    expect(Object.isFrozen(c.deadlines)).toBe(true);
    expect(Object.isFrozen(c.sections)).toBe(true);
  });

  test("every key parses and [briefing.deadlines] does not leak into [briefing]", () => {
    const src = [
      "[briefing]",
      "enabled = true",
      'schedule = "0 7 * * *"',
      'tz = "Europe/London"',
      'sections = ["mail", "calendar"]',
      "retention_days = 7",
      "[briefing.deadlines]",
      "enabled = true",
      "lead_hours = 48",
      "quiet_hours = 12",
      "snapshot_interval_minutes = 99",
      "[other]",
      "enabled = false",
      "[briefing]",
      "snapshot_interval_minutes = 30",
    ].join("\n");
    const seen: string[] = [];
    const c = parseNimbusTomlBriefing(src, (m) => seen.push(m));
    expect(seen).toEqual([]);
    expect(c.enabled).toBe(true);
    expect(c.schedule).toBe("0 7 * * *");
    expect(c.tz).toBe("Europe/London");
    expect(c.sections).toEqual(["mail", "calendar"]);
    expect(c.retentionDays).toBe(7);
    expect(c.snapshotIntervalMinutes).toBe(30);
    expect(c.deadlines).toEqual({ enabled: true, leadHours: 48, quietHours: 12 });
    expect(effectiveBriefingZone(c)).toBe("Europe/London");
    expect(typeof effectiveBriefingZone(DEFAULT_BRIEFING_CONFIG)).toBe("string");
  });

  test.each([
    ["enabled", '[briefing]\nenabled = "yes"\n', "enabled"],
    ["schedule too frequent", '[briefing]\nschedule = "* * * * *"\n', "schedule"],
    ["schedule half-hourly", '[briefing]\nschedule = "0,30 * * * *"\n', "schedule"],
    ["schedule nonsense", '[briefing]\nschedule = "nonsense"\n', "schedule"],
    ["tz", '[briefing]\ntz = "Mars/Base"\n', "tz"],
    ["empty sections", "[briefing]\nsections = []\n", "sections"],
    ["unknown section", '[briefing]\nsections = ["mail", "weather"]\n', "sections"],
    ["duplicate section", '[briefing]\nsections = ["mail", "mail"]\n', "sections"],
    ["sections not an array", '[briefing]\nsections = "calendar"\n', "sections"],
    ["an empty entry", '[briefing]\nsections = ["calendar", "", "mail"]\n', "sections"],
    ["an empty leading entry", '[briefing]\nsections = ["", "mail"]\n', "sections"],
    ["a doubled comma", '[briefing]\nsections = ["calendar",, "mail"]\n', "sections"],
    ["multi-line array", '[briefing]\nsections = [\n"mail",\n]\n', "sections"],
    ["retention 0", "[briefing]\nretention_days = 0\n", "retention_days"],
    ["retention 366", "[briefing]\nretention_days = 366\n", "retention_days"],
    ["retention 1.5", "[briefing]\nretention_days = 1.5\n", "retention_days"],
    ["lead 0", "[briefing.deadlines]\nlead_hours = 0\n", "lead_hours"],
    ["lead 169", "[briefing.deadlines]\nlead_hours = 169\n", "lead_hours"],
    ["quiet 0", "[briefing.deadlines]\nquiet_hours = 0\n", "quiet_hours"],
    ["quiet 337", "[briefing.deadlines]\nquiet_hours = 337\n", "quiet_hours"],
    ["deadlines enabled", "[briefing.deadlines]\nenabled = 1\n", "enabled"],
    ["snapshot 4", "[briefing]\nsnapshot_interval_minutes = 4\n", "snapshot_interval_minutes"],
    ["snapshot 241", "[briefing]\nsnapshot_interval_minutes = 241\n", "snapshot_interval_minutes"],
  ])("a bad %s falls back to its OWN default and names the key", (_l, src, key) => {
    const seen: string[] = [];
    const c = parseNimbusTomlBriefing(`${src}[briefing]\nretention_days = 9\n`, (m) =>
      seen.push(m),
    );
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.join("\n")).toContain(key);
    expect(c.retentionDays === 9 || key === "retention_days").toBe(true);
    expect(c.schedule === DEFAULT_BRIEFING_CONFIG.schedule || key !== "schedule").toBe(true);
    expect(c.sections.length).toBeGreaterThan(0);
  });

  test("an empty entry rejects the whole key; a trailing comma is still fine", () => {
    const seen: string[] = [];
    const bad = parseNimbusTomlBriefing('[briefing]\nsections = ["calendar", "", "mail"]\n', (m) =>
      seen.push(m),
    );
    expect(bad.sections).toEqual([...BRIEFING_SECTIONS]);
    expect(seen).toHaveLength(1);
    const ok = parseNimbusTomlBriefing('[briefing]\nsections = ["calendar", "mail",]\n');
    expect(ok.sections).toEqual(["calendar", "mail"]);
  });

  test("a bad tz does not also condemn the schedule", () => {
    const seen: string[] = [];
    const c = parseNimbusTomlBriefing(
      '[briefing]\ntz = "Mars/Base"\nschedule = "0 7 * * *"\n',
      (m) => seen.push(m),
    );
    expect(c.schedule).toBe("0 7 * * *");
    expect(c.tz).toBeNull();
    expect(seen).toHaveLength(1);
  });

  test("works without a fallback sink", () => {
    expect(parseNimbusTomlBriefing("[briefing]\nenabled = 3\n").enabled).toBe(false);
  });

  test("the layered loader reports an out-of-range retention_days for explain", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[briefing]\nretention_days = 999\n");
    const reader = initLayeredConfig(d);
    expect(loadNimbusBriefingFromConfigDir(d).retentionDays).toBe(30);
    expect(reader.sectionFallback("briefing")).toContain("retention_days");
  });
});
