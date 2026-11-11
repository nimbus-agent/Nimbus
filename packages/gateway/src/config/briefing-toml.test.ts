import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_BRIEFING_CONFIG,
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
