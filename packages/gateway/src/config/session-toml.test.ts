import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NIMBUS_SESSION_TOML,
  loadNimbusSessionFromConfigDir,
  loadNimbusSessionFromPath,
  parseNimbusTomlSessionSection,
} from "./session-toml.ts";

describe("parseNimbusTomlSessionSection", () => {
  test("comment-only file returns empty patch (defaults preserved by loader)", () => {
    const out = parseNimbusTomlSessionSection("# comment\n# another\n\n");
    expect(out).toEqual({});
  });

  test.each([
    ["a plain in-range value", "[session]\nmemory_ttl_hours = 12\n", 12],
    ["an inline comment stripped after the value", "[session]\nmemory_ttl_hours = 8 # eight\n", 8],
    [
      "the [session] key winning over an earlier foreign section",
      "[other]\nmemory_ttl_hours = 99\n\n[session]\nmemory_ttl_hours = 5\n",
      5,
    ],
    [
      "a later section switching the parser back off",
      "[session]\nmemory_ttl_hours = 5\n[other]\nmemory_ttl_hours = 99\n",
      5,
    ],
    ["CRLF line endings", "[session]\r\nmemory_ttl_hours = 6\r\n", 6],
  ])("applies memory_ttl_hours from %s", (_label, src, expected) => {
    expect(parseNimbusTomlSessionSection(src).memoryTtlHours).toBe(expected);
  });

  test.each([
    ["0 (must be > 0)", "[session]\nmemory_ttl_hours = 0\n"],
    ["an absurd out-of-range value (100000)", "[session]\nmemory_ttl_hours = 100000\n"],
    ["a negative value", "[session]\nmemory_ttl_hours = -5\n"],
    ["a non-numeric value (parseInt -> NaN)", "[session]\nmemory_ttl_hours = abc\n"],
    ["an unknown key inside [session]", "[session]\nunknown_key = 99\n"],
    ["a line with no '=' (eq <= 0 guard)", "[session]\nmemory_ttl_hours\n"],
  ])("leaves memoryTtlHours unset for %s", (_label, src) => {
    expect(parseNimbusTomlSessionSection(src).memoryTtlHours).toBeUndefined();
  });
});

describe("loadNimbusSessionFromPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-session-toml-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("non-existent file returns defaults", () => {
    const out = loadNimbusSessionFromPath(join(dir, "nimbus.toml"));
    expect(out).toEqual(DEFAULT_NIMBUS_SESSION_TOML);
  });

  test("existing file with valid value overrides default", () => {
    const path = join(dir, "nimbus.toml");
    writeFileSync(path, "[session]\nmemory_ttl_hours = 48\n");
    const out = loadNimbusSessionFromPath(path);
    expect(out.memoryTtlHours).toBe(48);
  });

  test("existing file with no overrides keeps the default", () => {
    const path = join(dir, "nimbus.toml");
    writeFileSync(path, "# just a comment\n");
    const out = loadNimbusSessionFromPath(path);
    expect(out.memoryTtlHours).toBe(DEFAULT_NIMBUS_SESSION_TOML.memoryTtlHours);
  });
});

describe("loadNimbusSessionFromConfigDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-session-toml-cd-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* harmless */
    }
  });

  test("joins configDir + 'nimbus.toml' and delegates to loadNimbusSessionFromPath", () => {
    writeFileSync(join(dir, "nimbus.toml"), "[session]\nmemory_ttl_hours = 3\n");
    const out = loadNimbusSessionFromConfigDir(dir);
    expect(out.memoryTtlHours).toBe(3);
  });

  test("empty configDir (no file) returns defaults", () => {
    const out = loadNimbusSessionFromConfigDir(dir);
    expect(out).toEqual(DEFAULT_NIMBUS_SESSION_TOML);
  });
});
