/**
 * Coverage for the pure TOML `[session]` section parser.
 *
 * Tier D — was at 20.75 % line coverage. Targets:
 *  - `parseNimbusTomlSessionSection` (pure parser, the bulk of the file)
 *  - `loadNimbusSessionFromPath` (file present / absent / unreadable)
 *  - `loadNimbusSessionFromConfigDir` (path-join wrapper)
 *
 * No bun:sqlite, no spawn, no env mutation — this is a string-in/value-out test.
 */

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

  test("[session] block with memory_ttl_hours = 12 applies the value", () => {
    const src = "[session]\nmemory_ttl_hours = 12\n";
    const out = parseNimbusTomlSessionSection(src);
    expect(out.memoryTtlHours).toBe(12);
  });

  test("memory_ttl_hours = 0 is rejected (must be > 0)", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours = 0\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("absurd out-of-range value (100000) is rejected", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours = 100000\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("negative value is rejected", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours = -5\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("non-numeric value is rejected (parseInt -> NaN)", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours = abc\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("inline comment after value is stripped before parsing", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours = 8 # eight hours\n");
    expect(out.memoryTtlHours).toBe(8);
  });

  test("keys outside [session] are ignored", () => {
    const src = "[other]\nmemory_ttl_hours = 99\n\n[session]\nmemory_ttl_hours = 5\n";
    const out = parseNimbusTomlSessionSection(src);
    expect(out.memoryTtlHours).toBe(5);
  });

  test("after [session], a new section switches the parser off", () => {
    const src = "[session]\nmemory_ttl_hours = 5\n[other]\nmemory_ttl_hours = 99\n";
    const out = parseNimbusTomlSessionSection(src);
    // First match takes effect; the [other] block must NOT overwrite it.
    expect(out.memoryTtlHours).toBe(5);
  });

  test("unknown key inside [session] is ignored", () => {
    const out = parseNimbusTomlSessionSection("[session]\nunknown_key = 99\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("line with no '=' is skipped (eq <= 0 guard)", () => {
    const out = parseNimbusTomlSessionSection("[session]\nmemory_ttl_hours\n");
    expect(out.memoryTtlHours).toBeUndefined();
  });

  test("CRLF line endings are handled", () => {
    const out = parseNimbusTomlSessionSection("[session]\r\nmemory_ttl_hours = 6\r\n");
    expect(out.memoryTtlHours).toBe(6);
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
