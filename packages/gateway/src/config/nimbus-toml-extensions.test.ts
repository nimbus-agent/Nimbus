import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NIMBUS_EXTENSIONS_RUNTIME,
  DEFAULT_NIMBUS_EXTENSIONS_TOML,
  loadNimbusExtensionsRuntimeFromConfigDir,
  parseNimbusExtensionsRuntime,
  parseNimbusExtensionsToml,
} from "./nimbus-toml.ts";

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

describe("parseNimbusExtensionsRuntime — [extensions].runtime (extension runtime PR 3)", () => {
  test("absent ⇒ true (the runtime is on by default)", () => {
    expect(parseNimbusExtensionsRuntime("")).toBe(true);
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
update_check_interval_hours = 2
`),
    ).toBe(true);
    expect(DEFAULT_NIMBUS_EXTENSIONS_RUNTIME).toBe(true);
  });

  test("runtime = false ⇒ false, runtime = true ⇒ true", () => {
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
runtime = false
`),
    ).toBe(false);
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
runtime = true
`),
    ).toBe(true);
  });

  test("a typo (runtime = flase) keeps the default and does not throw", () => {
    expect(() =>
      parseNimbusExtensionsRuntime(`[extensions]
runtime = flase
`),
    ).not.toThrow();
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
runtime = flase
`),
    ).toBe(true);
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
runtime = "false"
`),
    ).toBe(true);
  });

  test("runtime outside [extensions] is ignored", () => {
    expect(
      parseNimbusExtensionsRuntime(`[automation]
runtime = false
`),
    ).toBe(true);
  });

  test("the whole-section parser no longer carries a runtime field", () => {
    expect(
      Object.keys(
        parseNimbusExtensionsToml(`[extensions]
runtime = false
`),
      ),
    ).toEqual(["updateCheckIntervalHours", "trustCheckIntervalHours"]);
  });
});

describe("[extensions] trust_check_interval_hours", () => {
  test("defaults to 1 hour", () => {
    expect(parseNimbusExtensionsToml("").trustCheckIntervalHours).toBe(1);
  });

  test("accepts 1 through 24", () => {
    for (const n of [1, 6, 24]) {
      expect(
        parseNimbusExtensionsToml(`[extensions]
trust_check_interval_hours = ${n}
`).trustCheckIntervalHours,
      ).toBe(n);
    }
  });

  test("refuses 0, 25 and a non-integer", () => {
    for (const bad of ["0", "25", "1.5", '"x"']) {
      expect(() =>
        parseNimbusExtensionsToml(`[extensions]
trust_check_interval_hours = ${bad}
`),
      ).toThrow(/trust_check_interval_hours/);
    }
  });
});

describe("the [extensions] runtime kill switch is read on its own", () => {
  test("a bad update_check_interval_hours beside runtime = false cannot re-enable the runtime", () => {
    const raw = `[extensions]
update_check_interval_hours = 0
runtime = false
`;
    expect(parseNimbusExtensionsRuntime(raw)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "nimbus-ext-runtime-"));
    try {
      writeFileSync(join(dir, "nimbus.toml"), raw);
      expect(loadNimbusExtensionsRuntimeFromConfigDir(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no nimbus.toml ⇒ true; a typo ⇒ true", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-ext-runtime-"));
    try {
      expect(loadNimbusExtensionsRuntimeFromConfigDir(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(
      parseNimbusExtensionsRuntime(`[extensions]
runtime = flase
`),
    ).toBe(true);
  });
});
