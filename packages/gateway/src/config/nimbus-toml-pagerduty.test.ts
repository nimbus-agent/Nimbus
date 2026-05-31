import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_NIMBUS_PAGERDUTY_TOML,
  loadNimbusPagerdutyFromConfigDir,
  loadNimbusPagerdutyFromPath,
  parseNimbusPagerdutyToml,
} from "./nimbus-toml.ts";

describe("parseNimbusPagerdutyToml", () => {
  test("returns defaults when [pagerduty] is absent", () => {
    const out = parseNimbusPagerdutyToml("");
    expect(out).toEqual(DEFAULT_NIMBUS_PAGERDUTY_TOML);
    expect(out.maxPagesPerSync).toBe(20);
    expect(out.severityP1Aliases).toEqual([]);
  });

  test("reads max_pages_per_sync and severity_p1_aliases", () => {
    const out = parseNimbusPagerdutyToml(
      '[pagerduty]\nmax_pages_per_sync = 5\nseverity_p1_aliases = ["Critical", "SEV-1"]\n',
    );
    expect(out.maxPagesPerSync).toBe(5);
    expect(out.severityP1Aliases).toEqual(["critical", "sev-1"]);
  });

  test("ignores keys outside [pagerduty]", () => {
    const out = parseNimbusPagerdutyToml("[other]\nmax_pages_per_sync = 5\n");
    expect(out.maxPagesPerSync).toBe(20);
  });

  test("strips inline comments", () => {
    const out = parseNimbusPagerdutyToml("[pagerduty]\nmax_pages_per_sync = 10  # capped\n");
    expect(out.maxPagesPerSync).toBe(10);
  });

  test("throws when max_pages_per_sync is 0", () => {
    expect(() => parseNimbusPagerdutyToml("[pagerduty]\nmax_pages_per_sync = 0\n")).toThrow(
      /max_pages_per_sync.*1\.\.100/,
    );
  });

  test("throws when max_pages_per_sync is 101", () => {
    expect(() => parseNimbusPagerdutyToml("[pagerduty]\nmax_pages_per_sync = 101\n")).toThrow(
      /max_pages_per_sync.*1\.\.100/,
    );
  });

  test("throws when max_pages_per_sync is non-integer", () => {
    expect(() => parseNimbusPagerdutyToml('[pagerduty]\nmax_pages_per_sync = "lots"\n')).toThrow(
      /max_pages_per_sync/,
    );
  });

  test("throws when severity_p1_aliases is not an array", () => {
    expect(() =>
      parseNimbusPagerdutyToml("[pagerduty]\nseverity_p1_aliases = not-an-array\n"),
    ).toThrow(/expected array/);
  });

  test("lowercases + dedupes severity_p1_aliases", () => {
    const out = parseNimbusPagerdutyToml(
      '[pagerduty]\nseverity_p1_aliases = ["Critical", "critical", "P1"]\n',
    );
    expect(out.severityP1Aliases).toEqual(["critical", "p1"]);
  });

  test("drops empty / whitespace-only alias entries", () => {
    const out = parseNimbusPagerdutyToml(
      '[pagerduty]\nseverity_p1_aliases = ["Critical", "", "   "]\n',
    );
    expect(out.severityP1Aliases).toEqual(["critical"]);
  });
});

describe("loadNimbusPagerdutyFromPath", () => {
  test("returns defaults when file is missing", () => {
    const out = loadNimbusPagerdutyFromPath(join(tmpdir(), "does-not-exist.toml"));
    expect(out).toEqual(DEFAULT_NIMBUS_PAGERDUTY_TOML);
  });

  test("reads from disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pd-toml-"));
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, "[pagerduty]\nmax_pages_per_sync = 7\n", "utf8");
    const out = loadNimbusPagerdutyFromPath(p);
    expect(out.maxPagesPerSync).toBe(7);
  });

  test("falls back to defaults AND writes a stderr warning on validation error", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pd-toml-bad-"));
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, "[pagerduty]\nmax_pages_per_sync = 0\n", "utf8");
    const captured: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const out = loadNimbusPagerdutyFromPath(p);
      expect(out).toEqual(DEFAULT_NIMBUS_PAGERDUTY_TOML);
    } finally {
      process.stderr.write = orig;
    }
    expect(captured.join("")).toContain("[pagerduty] config");
    expect(captured.join("")).toContain("max_pages_per_sync");
  });
});

describe("loadNimbusPagerdutyFromConfigDir", () => {
  test("resolves <configDir>/nimbus.toml", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-pd-cfg-"));
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[pagerduty]\nmax_pages_per_sync = 3\nseverity_p1_aliases = ["SEV-1"]\n',
      "utf8",
    );
    const out = loadNimbusPagerdutyFromConfigDir(dir);
    expect(out.maxPagesPerSync).toBe(3);
    expect(out.severityP1Aliases).toEqual(["sev-1"]);
  });
});
