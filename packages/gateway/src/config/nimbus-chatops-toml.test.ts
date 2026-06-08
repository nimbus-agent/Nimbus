import { describe, expect, test } from "bun:test";
import { DEFAULT_NIMBUS_CHATOPS_TOML, parseNimbusChatopsToml } from "./nimbus-toml.ts";

describe("[chatops] config", () => {
  test("defaults: disabled, no platforms", () => {
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.enabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.slackEnabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.teamsEnabled).toBe(false);
    expect(DEFAULT_NIMBUS_CHATOPS_TOML.identityCacheTtlSeconds).toBe(900);
  });

  test("parses enabled platforms + ttl override", () => {
    const cfg = parseNimbusChatopsToml(
      `[chatops]\nenabled=true\nslack_enabled=true\nteams_enabled=false\nidentity_cache_ttl_seconds=300\n`,
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.slackEnabled).toBe(true);
    expect(cfg.teamsEnabled).toBe(false);
    expect(cfg.identityCacheTtlSeconds).toBe(300);
  });

  test("ignores unknown keys; keeps defaults", () => {
    const cfg = parseNimbusChatopsToml(`[chatops]\nbogus=123\n`);
    expect(cfg.enabled).toBe(false);
  });
});
