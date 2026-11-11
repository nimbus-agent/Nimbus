import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_STANDING_CONFIG,
  loadNimbusStandingFromConfigDir,
  loadNimbusStandingFromPath,
  parseNimbusTomlStanding,
  StandingConfigError,
} from "./standing-toml.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-standing-toml-"));
  dirs.push(d);
  return d;
}

describe("[standing] suggest_after", () => {
  test("defaults to 5 and the result is frozen", () => {
    const c = parseNimbusTomlStanding("");
    expect(c).toEqual(DEFAULT_STANDING_CONFIG);
    expect(c.suggestAfter).toBe(5);
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("reads 3, 50 and 0 (off); ignores other sections and keys", () => {
    for (const n of [3, 12, 50, 0]) {
      expect(
        parseNimbusTomlStanding(
          `[other]\nsuggest_after = 99\n[standing]\nsuggest_after = ${String(n)} # c\nx = 1\n`,
        ).suggestAfter,
      ).toBe(n);
    }
  });

  test("refuses 1, 2, 51, negative and non-numbers, naming the key", () => {
    for (const v of ["1", "2", "51", "-4", "abc", '"5x"']) {
      expect(() => parseNimbusTomlStanding(`[standing]\nsuggest_after = ${v}\n`)).toThrow(
        StandingConfigError,
      );
      expect(() => parseNimbusTomlStanding(`[standing]\nsuggest_after = ${v}\n`)).toThrow(
        /\[standing\]\.suggest_after/,
      );
    }
  });

  test("a file load returns the error as a value; a missing file is the default", () => {
    const d = tmp();
    const bad = join(d, "bad.toml");
    writeFileSync(bad, "[standing]\nsuggest_after = 2\n");
    const r = loadNimbusStandingFromPath(bad);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("suggest_after");
    expect(loadNimbusStandingFromPath(join(d, "none.toml"))).toEqual({
      ok: true,
      config: DEFAULT_STANDING_CONFIG,
    });
  });

  test("the layered loader reads the config dir's nimbus.toml", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[standing]\nsuggest_after = 7\n");
    const r = loadNimbusStandingFromConfigDir(d);
    expect(r).toEqual({ ok: true, config: { suggestAfter: 7 } });
  });

  test("the layered loader reports a bad value as an error value", () => {
    const d = tmp();
    writeFileSync(join(d, "nimbus.toml"), "[standing]\nsuggest_after = 1\n");
    expect(loadNimbusStandingFromConfigDir(d).ok).toBe(false);
  });
});
