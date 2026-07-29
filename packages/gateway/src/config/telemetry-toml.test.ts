import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NIMBUS_TELEMETRY_TOML,
  loadNimbusTelemetryFromPath,
  parseNimbusTomlTelemetrySection,
} from "./telemetry-toml.ts";

describe("parseNimbusTomlTelemetrySection", () => {
  test("parses telemetry block", () => {
    const raw = `
[telemetry]
enabled = true
endpoint = "https://example.com/ingest"
flush_interval_seconds = 120
`;
    const p = parseNimbusTomlTelemetrySection(raw);
    expect(p.enabled).toBe(true);
    expect(p.endpoint).toBe("https://example.com/ingest");
    expect(p.flushIntervalSeconds).toBe(120);
  });

  test("comment-only file yields an empty partial (defaults preserved upstream)", () => {
    const raw = `
# This is a comment-only TOML fragment
# with no actual config.
# [telemetry]  -- commented out, not a real section header.
`;
    const p = parseNimbusTomlTelemetrySection(raw);
    expect(p).toEqual({});
  });

  test("[telemetry] with enabled=false explicit (and no other keys) sets enabled only", () => {
    const raw = `
[telemetry]
enabled = false
`;
    const p = parseNimbusTomlTelemetrySection(raw);
    expect(p.enabled).toBe(false);
    expect(p.endpoint).toBeUndefined();
    expect(p.flushIntervalSeconds).toBeUndefined();
  });

  test("keys outside [telemetry] are ignored", () => {
    const raw = `
enabled = true   # at root, before any section — ignored
[other]
enabled = true
[telemetry]
flush_interval_seconds = 30
`;
    const p = parseNimbusTomlTelemetrySection(raw);
    expect(p.enabled).toBeUndefined();
    expect(p.flushIntervalSeconds).toBe(30);
  });

  test("invalid value types are silently dropped", () => {
    const raw = `
[telemetry]
enabled = maybe
flush_interval_seconds = not-a-number
endpoint = ""
`;
    const p = parseNimbusTomlTelemetrySection(raw);
    expect(p.enabled).toBeUndefined();
    expect(p.flushIntervalSeconds).toBeUndefined();
    expect(p.endpoint).toBeUndefined();
  });

  test("CRLF line endings are handled", () => {
    const p = parseNimbusTomlTelemetrySection(
      "[telemetry]\r\nenabled = true\r\nflush_interval_seconds = 60\r\n",
    );
    expect(p.enabled).toBe(true);
    expect(p.flushIntervalSeconds).toBe(60);
  });

  test("line with no '=' inside [telemetry] is skipped (eq <= 0 guard)", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nenabled\n");
    expect(p.enabled).toBeUndefined();
  });

  test("after [telemetry], entering another section stops capturing", () => {
    const raw = "[telemetry]\nenabled = true\n[other]\nenabled = false\n";
    const p = parseNimbusTomlTelemetrySection(raw);
    // Only the first enabled=true should be captured; the second is in [other]
    expect(p.enabled).toBe(true);
  });

  test("unknown key inside [telemetry] is silently ignored", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nunknown_key = 42\n");
    expect(p.enabled).toBeUndefined();
    expect(p.endpoint).toBeUndefined();
    expect(p.flushIntervalSeconds).toBeUndefined();
  });

  test("flush_interval_seconds = 0 is rejected (must be > 0)", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nflush_interval_seconds = 0\n");
    expect(p.flushIntervalSeconds).toBeUndefined();
  });

  test("flush_interval_seconds negative is rejected", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nflush_interval_seconds = -10\n");
    expect(p.flushIntervalSeconds).toBeUndefined();
  });

  test("unquoted endpoint string is parsed as-is", () => {
    const p = parseNimbusTomlTelemetrySection(
      "[telemetry]\nendpoint = https://unquoted.example.com\n",
    );
    expect(p.endpoint).toBe("https://unquoted.example.com");
  });

  test("endpoint quoted with escaped quote character", () => {
    // parseString replaces \\\" with " inside quoted strings
    const p = parseNimbusTomlTelemetrySection(
      '[telemetry]\nendpoint = "https://example.com/\\\\\\"path"\n',
    );
    // The escaped quote sequence \\\" in the TOML value becomes " in the result
    expect(p.endpoint).toContain("example.com");
  });

  test("inline comment after value is stripped before parsing", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nenabled = true # enable telemetry\n");
    expect(p.enabled).toBe(true);
  });

  test("inline comment after flush_interval_seconds value is stripped", () => {
    const p = parseNimbusTomlTelemetrySection(
      "[telemetry]\nflush_interval_seconds = 300 # 5 minutes\n",
    );
    expect(p.flushIntervalSeconds).toBe(300);
  });

  test("enabled = TRUE (uppercase) is case-insensitively parsed as true", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nenabled = TRUE\n");
    expect(p.enabled).toBe(true);
  });

  test("enabled = FALSE (uppercase) is case-insensitively parsed as false", () => {
    const p = parseNimbusTomlTelemetrySection("[telemetry]\nenabled = FALSE\n");
    expect(p.enabled).toBe(false);
  });
});

describe("loadNimbusTelemetryFromPath", () => {
  let dir: string;
  const ENV_ENABLED = "NIMBUS_TELEMETRY_ENABLED";
  const ENV_ENDPOINT = "NIMBUS_TELEMETRY_ENDPOINT";
  const ENV_FLUSH = "NIMBUS_TELEMETRY_FLUSH_SECONDS";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-telemetry-toml-"));
    // Clear all override env vars before each test
    Reflect.deleteProperty(process.env, ENV_ENABLED);
    Reflect.deleteProperty(process.env, ENV_ENDPOINT);
    Reflect.deleteProperty(process.env, ENV_FLUSH);
  });

  afterEach(() => {
    // Restore env vars
    Reflect.deleteProperty(process.env, ENV_ENABLED);
    Reflect.deleteProperty(process.env, ENV_ENDPOINT);
    Reflect.deleteProperty(process.env, ENV_FLUSH);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  test("non-existent file returns defaults", () => {
    const out = loadNimbusTelemetryFromPath(join(dir, "telemetry.toml"));
    expect(out.enabled).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.enabled);
    expect(out.endpoint).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.endpoint);
    expect(out.flushIntervalSeconds).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.flushIntervalSeconds);
  });

  test("existing file with valid values overrides defaults", () => {
    const path = join(dir, "telemetry.toml");
    writeFileSync(path, "[telemetry]\nenabled = true\nflush_interval_seconds = 900\n");
    const out = loadNimbusTelemetryFromPath(path);
    expect(out.enabled).toBe(true);
    expect(out.flushIntervalSeconds).toBe(900);
    expect(out.endpoint).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.endpoint);
  });

  test("existing file with no telemetry overrides keeps defaults", () => {
    const path = join(dir, "telemetry.toml");
    writeFileSync(path, "# just a comment\n");
    const out = loadNimbusTelemetryFromPath(path);
    expect(out).toEqual(DEFAULT_NIMBUS_TELEMETRY_TOML);
  });

  test("file path that is a directory triggers catch and returns defaults", () => {
    // readFileSync throws EISDIR on a directory path — exercises the catch arm
    const subdir = join(dir, "is-a-dir");
    mkdirSync(subdir);
    const out = loadNimbusTelemetryFromPath(subdir);
    expect(out.enabled).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.enabled);
    expect(out.endpoint).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.endpoint);
    expect(out.flushIntervalSeconds).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.flushIntervalSeconds);
  });
});

describe("applyTelemetryEnvOverrides (via loadNimbusTelemetryFromPath)", () => {
  let dir: string;
  const ENV_ENABLED = "NIMBUS_TELEMETRY_ENABLED";
  const ENV_ENDPOINT = "NIMBUS_TELEMETRY_ENDPOINT";
  const ENV_FLUSH = "NIMBUS_TELEMETRY_FLUSH_SECONDS";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-telemetry-env-"));
    Reflect.deleteProperty(process.env, ENV_ENABLED);
    Reflect.deleteProperty(process.env, ENV_ENDPOINT);
    Reflect.deleteProperty(process.env, ENV_FLUSH);
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, ENV_ENABLED);
    Reflect.deleteProperty(process.env, ENV_ENDPOINT);
    Reflect.deleteProperty(process.env, ENV_FLUSH);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* harmless */
    }
  });

  function loadDefaults(): ReturnType<typeof loadNimbusTelemetryFromPath> {
    // Use a non-existent path so only env overrides apply
    return loadNimbusTelemetryFromPath(join(dir, "no-such-file.toml"));
  }

  // Truthy/falsy spellings are matched case-insensitively.
  test.each(["1", "true", "TRUE"])("NIMBUS_TELEMETRY_ENABLED=%s forces enabled=true", (raw) => {
    process.env[ENV_ENABLED] = raw;
    expect(loadDefaults().enabled).toBe(true);
  });

  test.each(["0", "false", "FALSE"])("NIMBUS_TELEMETRY_ENABLED=%s forces enabled=false", (raw) => {
    process.env[ENV_ENABLED] = raw;
    expect(loadDefaults().enabled).toBe(false);
  });

  test("NIMBUS_TELEMETRY_ENABLED with unrecognized value leaves default unchanged", () => {
    process.env[ENV_ENABLED] = "maybe";
    expect(loadDefaults().enabled).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.enabled);
  });

  test("NIMBUS_TELEMETRY_ENDPOINT non-empty overrides endpoint", () => {
    process.env[ENV_ENDPOINT] = "https://custom.endpoint.example.com/v2";
    expect(loadDefaults().endpoint).toBe("https://custom.endpoint.example.com/v2");
  });

  test("NIMBUS_TELEMETRY_ENDPOINT empty string leaves default endpoint", () => {
    process.env[ENV_ENDPOINT] = "";
    expect(loadDefaults().endpoint).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.endpoint);
  });

  test("NIMBUS_TELEMETRY_ENDPOINT whitespace-only is trimmed to empty, leaves default", () => {
    process.env[ENV_ENDPOINT] = "   ";
    expect(loadDefaults().endpoint).toBe(DEFAULT_NIMBUS_TELEMETRY_TOML.endpoint);
  });

  test("NIMBUS_TELEMETRY_FLUSH_SECONDS valid in-range value is applied directly", () => {
    process.env[ENV_FLUSH] = "600";
    expect(loadDefaults().flushIntervalSeconds).toBe(600);
  });

  test("NIMBUS_TELEMETRY_FLUSH_SECONDS below minimum (60) is clamped to 60", () => {
    process.env[ENV_FLUSH] = "10";
    expect(loadDefaults().flushIntervalSeconds).toBe(60);
  });

  test("NIMBUS_TELEMETRY_FLUSH_SECONDS above maximum (86400) is clamped to 86400", () => {
    process.env[ENV_FLUSH] = "999999";
    expect(loadDefaults().flushIntervalSeconds).toBe(86_400);
  });

  // A value that is not a positive number at all leaves the default untouched — unlike an
  // out-of-range positive number, which clamps.
  test.each([
    ["0 (must be > 0)", "0"],
    ["negative", "-100"],
    ["non-numeric", "not-a-number"],
    ["empty string", ""],
  ])("NIMBUS_TELEMETRY_FLUSH_SECONDS %s leaves the default", (_label, raw) => {
    process.env[ENV_FLUSH] = raw;
    expect(loadDefaults().flushIntervalSeconds).toBe(
      DEFAULT_NIMBUS_TELEMETRY_TOML.flushIntervalSeconds,
    );
  });

  test("all three env overrides applied together", () => {
    process.env[ENV_ENABLED] = "1";
    process.env[ENV_ENDPOINT] = "https://override.example.com";
    process.env[ENV_FLUSH] = "3600";
    const out = loadDefaults();
    expect(out.enabled).toBe(true);
    expect(out.endpoint).toBe("https://override.example.com");
    expect(out.flushIntervalSeconds).toBe(3600);
  });
});
