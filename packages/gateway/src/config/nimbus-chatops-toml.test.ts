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

  test("parses bot_vault_entry + teams_bot_app_id string overrides", () => {
    const cfg = parseNimbusChatopsToml(
      `[chatops]\nbot_vault_entry="acme-bot"\nteams_bot_app_id="app-123"\n`,
    );
    expect(cfg.botVaultEntry).toBe("acme-bot");
    expect(cfg.teamsBotAppId).toBe("app-123");
  });

  test("malformed boolean leaves the default (parseBool undefined branch)", () => {
    const cfg = parseNimbusChatopsToml(
      `[chatops]\nenabled=maybe\nslack_enabled=yep\nteams_enabled=nah\n`,
    );
    expect(cfg.enabled).toBe(false);
    expect(cfg.slackEnabled).toBe(false);
    expect(cfg.teamsEnabled).toBe(false);
  });

  test("negative / non-numeric ttl is rejected, default retained; zero accepted", () => {
    expect(
      parseNimbusChatopsToml(`[chatops]\nidentity_cache_ttl_seconds=-5\n`).identityCacheTtlSeconds,
    ).toBe(900);
    expect(
      parseNimbusChatopsToml(`[chatops]\nidentity_cache_ttl_seconds=abc\n`).identityCacheTtlSeconds,
    ).toBe(900);
    expect(
      parseNimbusChatopsToml(`[chatops]\nidentity_cache_ttl_seconds=0\n`).identityCacheTtlSeconds,
    ).toBe(0);
  });
});
