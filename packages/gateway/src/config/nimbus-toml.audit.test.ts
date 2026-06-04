import { describe, expect, test } from "bun:test";

import { DEFAULT_NIMBUS_AUDIT_TOML, parseNimbusAuditToml } from "./nimbus-toml.ts";

describe("parseNimbusAuditToml", () => {
  test("defaults to 90 days when no [audit] section", () => {
    expect(parseNimbusAuditToml("")).toEqual({ toolCallLogRetentionDays: 90 });
    expect(DEFAULT_NIMBUS_AUDIT_TOML).toEqual({ toolCallLogRetentionDays: 90 });
  });

  test("reads a valid integer retention", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 30\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(30);
  });

  test("0 disables pruning (kept forever)", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 0\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(0);
  });

  test("throws on a non-integer value", () => {
    const raw = "[audit]\ntool_call_log_retention_days = 12.5\n";
    expect(() => parseNimbusAuditToml(raw)).toThrow();
  });

  test("throws on a negative or out-of-range value", () => {
    expect(() => parseNimbusAuditToml("[audit]\ntool_call_log_retention_days = -1\n")).toThrow();
    expect(() => parseNimbusAuditToml("[audit]\ntool_call_log_retention_days = 40000\n")).toThrow();
  });

  test("ignores entries outside the [audit] section", () => {
    const raw = "[other]\ntool_call_log_retention_days = 5\n";
    expect(parseNimbusAuditToml(raw).toolCallLogRetentionDays).toBe(90);
  });
});
