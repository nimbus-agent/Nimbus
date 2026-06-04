import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_SECURITY_TOML, parseNimbusSecurityToml } from "./nimbus-toml.ts";

describe("parseNimbusSecurityToml", () => {
  test("defaults: extended off, empty allowlist", () => {
    expect(parseNimbusSecurityToml("")).toEqual(DEFAULT_NIMBUS_SECURITY_TOML);
    expect(DEFAULT_NIMBUS_SECURITY_TOML).toEqual({
      extendedPatterns: false,
      allowlistFingerprints: [],
    });
  });

  test("reads extended_patterns = true", () => {
    expect(parseNimbusSecurityToml("[security]\nextended_patterns = true\n").extendedPatterns).toBe(
      true,
    );
  });

  test("collects [[security.allowlist]] fingerprints", () => {
    const raw = [
      "[[security.allowlist]]",
      'fingerprint = "aaaa1111"',
      "[[security.allowlist]]",
      'fingerprint = "bbbb2222"',
    ].join("\n");
    expect(parseNimbusSecurityToml(raw).allowlistFingerprints).toEqual(["aaaa1111", "bbbb2222"]);
  });

  test("both sections together", () => {
    const raw = [
      "[security]",
      "extended_patterns = true",
      "",
      "[[security.allowlist]]",
      'fingerprint = "deadbeef"',
    ].join("\n");
    const cfg = parseNimbusSecurityToml(raw);
    expect(cfg.extendedPatterns).toBe(true);
    expect(cfg.allowlistFingerprints).toEqual(["deadbeef"]);
  });

  test("ignores fingerprint keys outside [[security.allowlist]]", () => {
    const raw = '[other]\nfingerprint = "nope"\n';
    expect(parseNimbusSecurityToml(raw).allowlistFingerprints).toEqual([]);
  });
});
