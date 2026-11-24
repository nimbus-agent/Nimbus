import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_INCIDENT_CONFIG,
  loadNimbusIncidentFromConfigDir,
  parseNimbusTomlIncident,
} from "./incident-toml.ts";
import { initLayeredConfig, resetLayeredConfigsForTests } from "./layered-config.ts";

const dirs: string[] = [];
afterEach(() => {
  resetLayeredConfigsForTests();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-incident-toml-"));
  dirs.push(d);
  return d;
}

describe("[incident]", () => {
  test("defaults with no section, frozen", () => {
    const c = parseNimbusTomlIncident("");
    expect(c).toEqual(DEFAULT_INCIDENT_CONFIG);
    expect(c.enabled).toBe(true);
    expect(c.retentionDays).toBe(365);
    expect(c.lookbackDays).toBe(7);
    expect(c.severities).toEqual([]);
    expect(c.bigeyeSlaStatuses).toEqual([]);
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("every key parses; lists are lower-cased and de-duplicated", () => {
    const c = parseNimbusTomlIncident(
      [
        "[incident]",
        "enabled = false",
        'severities = ["P1", "SEV-1", "p1"]',
        'bigeye_sla_statuses = ["Breached", "breached"]',
        "retention_days = 30",
        "lookback_days = 14 # two weeks",
      ].join("\r\n"),
    );
    expect(c).toEqual({
      enabled: false,
      severities: ["p1", "sev-1"],
      bigeyeSlaStatuses: ["breached"],
      retentionDays: 30,
      lookbackDays: 14,
      dataSchemaLookbackHours: 24,
    });
  });

  test("sub-tables and expect tables do not leak into the section", () => {
    const c = parseNimbusTomlIncident(
      '[incident.expect]\nenabled = false\n[[incident.expect]]\nseverities = ["p1"]\n[other]\nretention_days = 9\n',
    );
    expect(c).toEqual(DEFAULT_INCIDENT_CONFIG);
  });

  test("a malformed array is ignored and the value in effect stands", () => {
    const c = parseNimbusTomlIncident(
      '[incident]\nseverities = "p1"\nbigeye_sla_statuses = [\n"x",\n]\nenabled = maybe\n',
    );
    expect(c.severities).toEqual([]);
    expect(c.bigeyeSlaStatuses).toEqual([]);
    expect(c.enabled).toBe(true);
  });

  test.each([
    ["retention_days", "6", "7..3650", 365],
    ["retention_days", "3651", "7..3650", 365],
    ["retention_days", "0", "7..3650", 365],
    ["retention_days", "abc", "7..3650", 365],
    ["lookback_days", "0", "1..90", 7],
    ["lookback_days", "91", "1..90", 7],
    ["lookback_days", "1.5", "1..90", 7],
  ])("%s = %s falls back and reports the range", (key, raw, range, expected) => {
    const seen: string[] = [];
    const c = parseNimbusTomlIncident(`[incident]\n${key} = ${raw}\n`, (m) => seen.push(m));
    expect(key === "retention_days" ? c.retentionDays : c.lookbackDays).toBe(expected);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(key);
    expect(seen[0]).toContain(range);
  });

  test("bounds are accepted and a fallback works without a sink", () => {
    expect(
      parseNimbusTomlIncident("[incident]\nretention_days = 7\nlookback_days = 90\n"),
    ).toMatchObject({
      retentionDays: 7,
      lookbackDays: 90,
    });
    expect(parseNimbusTomlIncident("[incident]\nlookback_days = 500\n").lookbackDays).toBe(7);
  });

  test("the layered loader reads the config dir and records the fallback for explain", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[incident]\nlookback_days = 30\n");
    expect(loadNimbusIncidentFromConfigDir(d).lookbackDays).toBe(30);
    writeFileSync(join(d, "nimbus.toml"), "[incident]\nretention_days = 1\n");
    resetLayeredConfigsForTests();
    const reader = initLayeredConfig(d);
    expect(loadNimbusIncidentFromConfigDir(d).retentionDays).toBe(365);
    expect(reader.sectionFallback("incident")).toContain("retention_days");
  });

  test("no file gives the default", () => {
    expect(loadNimbusIncidentFromConfigDir(tmp())).toEqual(DEFAULT_INCIDENT_CONFIG);
  });
});

describe("[incident] data_schema_lookback_hours", () => {
  test("defaults to 24 and accepts 1..168", () => {
    expect(parseNimbusTomlIncident("").dataSchemaLookbackHours).toBe(24);
    const c = parseNimbusTomlIncident("[incident]\ndata_schema_lookback_hours = 72\n");
    expect(c.dataSchemaLookbackHours).toBe(72);
  });

  test("out of range is a recorded fallback to the default, never clamped", () => {
    const seen: string[] = [];
    for (const v of ["0", "169", "abc"]) {
      const c = parseNimbusTomlIncident(`[incident]\ndata_schema_lookback_hours = ${v}\n`, (m) =>
        seen.push(m),
      );
      expect(c.dataSchemaLookbackHours).toBe(24);
    }
    expect(seen).toHaveLength(3);
  });
});
