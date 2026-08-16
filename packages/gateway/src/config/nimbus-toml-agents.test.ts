import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_AGENTS_TOML, parseNimbusAgentsToml } from "./nimbus-toml.ts";

describe("[agents]", () => {
  test("defaults to local synthesis with a 20s timeout", () => {
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesis).toBe("local");
    expect(DEFAULT_NIMBUS_AGENTS_TOML.synthesisTimeoutMs).toBe(20000);
  });

  test("parses all three modes", () => {
    for (const mode of ["off", "local", "allow-remote"] as const) {
      expect(parseNimbusAgentsToml(`[agents]\nsynthesis = "${mode}"\n`).synthesis).toBe(mode);
    }
  });

  test("an unrecognised mode falls back to the safe default, never widening to allow-remote", () => {
    expect(parseNimbusAgentsToml(`[agents]\nsynthesis = "remote"\n`).synthesis).toBe("local");
  });

  test("an absent section yields the defaults", () => {
    expect(parseNimbusAgentsToml("").synthesis).toBe("local");
  });

  test("parses synthesis_timeout_ms", () => {
    expect(
      parseNimbusAgentsToml(`[agents]\nsynthesis_timeout_ms = 4500\n`).synthesisTimeoutMs,
    ).toBe(4500);
  });

  test("a non-numeric timeout falls back to the default rather than 0", () => {
    expect(
      parseNimbusAgentsToml(`[agents]\nsynthesis_timeout_ms = "soon"\n`).synthesisTimeoutMs,
    ).toBe(20000);
  });
});
