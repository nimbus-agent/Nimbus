import { describe, expect, test } from "bun:test";

import { parseNimbusTomlTelemetrySection } from "./telemetry-toml.ts";

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
});
