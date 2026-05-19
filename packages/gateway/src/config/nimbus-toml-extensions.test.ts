import { describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_EXTENSIONS_TOML, parseNimbusExtensionsToml } from "./nimbus-toml.ts";

describe("parseNimbusExtensionsToml — [extensions].update_check_interval_hours (T2 PR 3)", () => {
  test("defaults update_check_interval_hours to 24", () => {
    expect(parseNimbusExtensionsToml("")).toEqual(DEFAULT_NIMBUS_EXTENSIONS_TOML);
    expect(DEFAULT_NIMBUS_EXTENSIONS_TOML.updateCheckIntervalHours).toBe(24);
  });

  test("accepts 1", () => {
    const out = parseNimbusExtensionsToml(`[extensions]\nupdate_check_interval_hours = 1\n`);
    expect(out.updateCheckIntervalHours).toBe(1);
  });

  test("accepts 168", () => {
    const out = parseNimbusExtensionsToml(`[extensions]\nupdate_check_interval_hours = 168\n`);
    expect(out.updateCheckIntervalHours).toBe(168);
  });

  test("rejects 0", () => {
    expect(() =>
      parseNimbusExtensionsToml(`[extensions]\nupdate_check_interval_hours = 0\n`),
    ).toThrow(/update_check_interval_hours/);
  });

  test("rejects 169", () => {
    expect(() =>
      parseNimbusExtensionsToml(`[extensions]\nupdate_check_interval_hours = 169\n`),
    ).toThrow(/update_check_interval_hours/);
  });

  test("rejects non-integer", () => {
    expect(() =>
      parseNimbusExtensionsToml(`[extensions]\nupdate_check_interval_hours = 1.5\n`),
    ).toThrow(/integer/);
  });

  test("ignores unknown keys in [extensions]", () => {
    const out = parseNimbusExtensionsToml(`[extensions]\nunknown_key = "ignored"\n`);
    expect(out).toEqual(DEFAULT_NIMBUS_EXTENSIONS_TOML);
  });

  test("ignores keys outside [extensions]", () => {
    const out = parseNimbusExtensionsToml(`[automation]\nupdate_check_interval_hours = 5\n`);
    expect(out).toEqual(DEFAULT_NIMBUS_EXTENSIONS_TOML);
  });
});
